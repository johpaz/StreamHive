use crate::chat_store as db;
use crate::*;
impl From<db::Failure> for Error {
    fn from(e: db::Failure) -> Self {
        match e {
            db::Failure::Invalid(m) => invalid(m),
            db::Failure::Limited => Error(
                StatusCode::TOO_MANY_REQUESTS,
                "Espera unos segundos antes de enviar otro mensaje",
            ),
            db::Failure::Closed => Error(StatusCode::GONE, "La conversación terminó"),
            db::Failure::Database(e) => e.into(),
        }
    }
}
#[derive(Clone)]
enum Actor {
    Owner(String),
    Guest(String),
}
async fn actor(s: &App, h: &HeaderMap, sid: &str) -> Result<Actor> {
    if h.contains_key(header::AUTHORIZATION) {
        return Ok(Actor::Owner(owner(s, h).await?));
    }
    let (room, pid) = guest(s, h).await?;
    if room != sid {
        return Err(denied());
    }
    Ok(Actor::Guest(pid))
}
fn check(c: &Connection, sid: &str, a: &Actor) -> Result<(String, String, String)> {
    match a {
        Actor::Owner(oid)=>{session_owned(c,sid,oid)?;Ok((oid.clone(),"Anfitrión".into(),"admin".into()))},
        // Quienes esperan también participan del chat para coordinar su ingreso.
        Actor::Guest(pid)=>c.query_row("SELECT p.id,p.name,p.status FROM participants p JOIN sessions s ON s.id=p.session_id JOIN invitations i ON i.id=p.invitation_id WHERE p.id=?1 AND p.session_id=?2 AND p.status IN ('admitted','waiting') AND s.closed=0 AND s.expires>?3 AND i.revoked=0 AND i.expires>?3",params![pid,sid,now()],|r|Ok((r.get(0)?,r.get(1)?,if r.get::<_,String>(2)?=="waiting"{"waiting".into()}else{"guest".into()}))).optional()?.ok_or_else(denied)
    }
}
pub async fn authorized(s: &App, h: &HeaderMap, sid: &str) -> Result<()> {
    let a = actor(s, h, sid).await?;
    let sid = sid.to_owned();
    s.db(move |c| {
        check(c, &sid, &a)?;
        Ok(())
    })
    .await
}
pub async fn history(
    State(s): State<App>,
    h: HeaderMap,
    Query(p): Query<db::Page>,
) -> Result<Json<Value>> {
    let sid = p
        .session_id
        .clone()
        .ok_or_else(|| invalid("Sesión requerida"))?;
    let a = actor(&s, &h, &sid).await?;
    s.db(move |c| {
        let (viewer, _, _) = check(c, &sid, &a)?;
        db::ensure(c, &sid)?;
        db::page(c, &sid, &p)
            .map(|mut v| {
                v["viewer_id"] = json!(viewer);
                v
            })
            .map_err(Error::from)
    })
    .await
    .map(Json)
}
pub async fn send(
    State(s): State<App>,
    h: HeaderMap,
    Json(b): Json<db::Send>,
) -> Result<Json<Value>> {
    let sid = b.session_id.clone();
    let key = sid.clone();
    let a = actor(&s, &h, &sid).await?;
    let v = s
        .db(move |c| {
            let (id, name, role) = check(c, &key, &a)?;
            db::ensure(c, &key)?;
            db::send(c, &key, &id, &name, &role, &b, now()).map_err(Error::from)
        })
        .await?;
    s.chat_bus.notify(&sid, "chat.message");
    Ok(Json(v))
}
pub async fn delete(
    State(s): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(p): Query<db::Page>,
) -> Result<Json<Value>> {
    let sid = p.session_id.ok_or_else(|| invalid("Sesión requerida"))?;
    let key = sid.clone();
    let a = actor(&s, &h, &sid).await?;
    if !matches!(a, Actor::Owner(_)) {
        return Err(denied());
    }
    let v = s
        .db(move |c| {
            check(c, &key, &a)?;
            db::delete(c, &key, &id).map_err(Error::from)
        })
        .await?;
    s.chat_bus.notify(&sid, "chat.deleted");
    Ok(Json(v))
}
