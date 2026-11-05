use crate::{App, Error, Reply, bad, chat_store as db, denied};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use serde_json::json;
impl From<db::Failure> for Error {
    fn from(e: db::Failure) -> Self {
        match e {
            db::Failure::Invalid(m) => bad(m),
            db::Failure::Limited => Self(
                StatusCode::TOO_MANY_REQUESTS,
                "Espera unos segundos antes de enviar otro mensaje".into(),
            ),
            db::Failure::Closed => Self(
                StatusCode::GONE,
                "La conversación terminó. Abre el chat de nuevo".into(),
            ),
            db::Failure::Database(e) => Self::from(anyhow::Error::from(e)),
        }
    }
}
pub async fn identity(s: &App, h: &HeaderMap) -> Result<(String, String, String), Error> {
    let c = s.auth(h)?;
    if c.role == "admin" {
        return Ok((c.sub, "Anfitrión".into(), "admin".into()));
    }
    let d = s.data.lock().await;
    let p = d
        .participants
        .get(&c.sub)
        .filter(|p| p.status == "admitted")
        .ok_or_else(denied)?;
    Ok((c.sub, p.name.clone(), "guest".into()))
}
async fn local<T: Send + 'static>(
    s: &App,
    f: impl FnOnce(&mut rusqlite::Connection) -> Result<T, db::Failure> + Send + 'static,
) -> Result<T, Error> {
    let store = s.store.clone();
    tokio::task::spawn_blocking(move || f(&mut store.lock().unwrap().conn))
        .await
        .map_err(|_| bad("Chat no disponible"))?
        .map_err(Error::from)
}
pub async fn history(State(s): State<App>, h: HeaderMap, Query(p): Query<db::Page>) -> Reply {
    let (viewer, _, role) = identity(&s, &h).await?;
    if role == "admin" && crate::remote::chat_selected(&s) {
        return crate::remote::chat_request(&s, reqwest::Method::GET, &p, None, None)
            .await
            .map(Json);
    }
    // Hold admission stable until the read finishes.
    let d = s.data.lock().await;
    if role != "admin"
        && !d
            .participants
            .get(&s.auth(&h)?.sub)
            .is_some_and(|p| p.status == "admitted")
    {
        return Err(denied());
    }
    local(&s, move |c| {
        let sid = db::local(c)?;
        if p.session_id.as_ref().is_some_and(|id| id != &sid) {
            return Err(db::Failure::Closed);
        }
        db::page(c, &sid, &p).map(|mut v| {
            v["can_reset"] = json!(true);
            v["viewer_id"] = json!(viewer);
            v
        })
    })
    .await
    .map(Json)
}
pub async fn send(State(s): State<App>, h: HeaderMap, Json(b): Json<db::Send>) -> Reply {
    let (id, name, role) = identity(&s, &h).await?;
    if role == "admin" && crate::remote::chat_selected(&s) {
        return crate::remote::chat_request(
            &s,
            reqwest::Method::POST,
            &db::Page::default(),
            None,
            Some(serde_json::to_value(b).unwrap()),
        )
        .await
        .map(Json);
    }
    let d = s.data.lock().await;
    if role != "admin"
        && !d
            .participants
            .get(&id)
            .is_some_and(|p| p.status == "admitted")
    {
        return Err(denied());
    }
    let result = local(&s, move |c| {
        let sid = db::local(c)?;
        if sid != b.session_id {
            return Err(db::Failure::Closed);
        }
        db::send(c, &sid, &id, &name, &role, &b, crate::now() as i64)
    })
    .await?;
    s.chat_bus
        .notify(result["conversation_id"].as_str().unwrap(), "chat.message");
    Ok(Json(result))
}
pub async fn delete(
    State(s): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(p): Query<db::Page>,
) -> Reply {
    s.admin(&h)?;
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err(bad("Mensaje inválido"));
    }
    if crate::remote::chat_selected(&s) {
        return crate::remote::chat_request(&s, reqwest::Method::DELETE, &p, Some(&id), None)
            .await
            .map(Json);
    }
    let result = local(&s, move |c| {
        let sid = db::local(c)?;
        if p.session_id.as_deref() != Some(&sid) {
            return Err(db::Failure::Closed);
        }
        db::delete(c, &sid, &id)
    })
    .await?;
    s.chat_bus
        .notify(result["conversation_id"].as_str().unwrap(), "chat.deleted");
    Ok(Json(result))
}
pub async fn rotate(State(s): State<App>, h: HeaderMap, Json(p): Json<db::Page>) -> Reply {
    s.admin(&h)?;
    if crate::remote::chat_selected(&s) {
        return Err(bad("La conversación remota termina al cerrar la sesión"));
    }
    let result = local(&s, move |c| {
        let tx = c.transaction()?;
        let old = db::local(&tx)?;
        if p.session_id.as_deref() != Some(&old) {
            return Err(db::Failure::Closed);
        }
        db::close(&tx, &old, crate::now() as i64)?;
        let new = db::local(&tx)?;
        tx.commit()?;
        Ok(json!({"previous":old,"conversation_id":new}))
    })
    .await?;
    s.chat_bus
        .notify(result["previous"].as_str().unwrap(), "chat.closed");
    Ok(Json(result))
}
pub fn start_pruner(s: App) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            tick.tick().await;
            let _ = local(&s, |c| Ok(db::prune(c, crate::now() as i64)?)).await;
        }
    });
}
