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
            db::Failure::TooLarge => Self(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Cada archivo puede pesar hasta 25 MB".into(),
            ),
            db::Failure::Io(e) => Self::from(anyhow::anyhow!(e)),
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
    let p = d.participants.get(&c.sub).ok_or_else(denied)?;
    let role = guest_role(&p.status).ok_or_else(denied)?;
    Ok((c.sub, p.name.clone(), role.into()))
}
/// El chat es para todas las personas del estudio: quienes están en el directo
/// y quienes esperan entrar, para coordinar ingresos. Las retiradas no lo ven.
pub fn guest_role(status: &str) -> Option<&'static str> {
    match status {
        "admitted" => Some("guest"),
        "waiting" => Some("waiting"),
        _ => None,
    }
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
            .is_some_and(|p| guest_role(&p.status).is_some())
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
            .is_some_and(|p| guest_role(&p.status).is_some())
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
    sweep(&s).await;
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
            sweep(&s).await;
        }
    });
}
#[derive(serde::Deserialize)]
pub struct FileQuery {
    session_id: String,
}
fn encoded_name(h: &HeaderMap) -> Result<(String, String), Error> {
    use base64::Engine;
    let raw = h
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| bad("Nombre de archivo inválido"))?;
    let name = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .ok()
        .and_then(|v| String::from_utf8(v).ok())
        .filter(|n| db::valid_file_name(n))
        .ok_or_else(|| bad("Nombre de archivo inválido"))?;
    Ok((raw.to_owned(), name))
}
const UNSUPPORTED: &str =
    "Formato no admitido: PDF, imágenes, texto, CSV, Office, OpenDocument o ZIP";
/// Materiales del chat. Anfitrión e invitados (en directo o en espera) suben un
/// archivo y lo envían después en un mensaje con `attachment_id`.
pub async fn upload(
    State(s): State<App>,
    Query(q): Query<FileQuery>,
    req: axum::extract::Request,
) -> Reply {
    let h = req.headers().clone();
    let (raw, name) = encoded_name(&h)?;
    let (uploader, _, role) = identity(&s, &h).await?;
    if req
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .is_some_and(|n| n > db::MAX_FILE)
    {
        return Err(db::Failure::TooLarge.into());
    }
    if role == "admin" && crate::remote::chat_selected(&s) {
        use futures_util::StreamExt;
        let mut stream = req.into_body().into_data_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| bad("Se interrumpió la subida"))?;
            if (bytes.len() + chunk.len()) as u64 > db::MAX_FILE {
                return Err(db::Failure::TooLarge.into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if db::sniff(&name, &bytes[..bytes.len().min(4096)]).is_none() {
            return Err(bad(UNSUPPORTED));
        }
        return crate::remote::chat_upload(&s, &q.session_id, &raw, bytes)
            .await
            .map(Json);
    }
    let sid = q.session_id;
    let id = uuid::Uuid::new_v4().to_string();
    let (size, head) = db::receive(req.into_body(), &s.chat_files, &id).await?;
    let path = s.chat_files.join(&id);
    let Some(mime) = db::sniff(&name, &head) else {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(bad(UNSUPPORTED));
    };
    // La admisión se comprueba otra vez: la subida pudo tardar.
    let file = id.clone();
    let result = match identity(&s, &h).await {
        Ok(_) => {
            local(&s, move |c| {
                if db::local(c)? != sid {
                    return Err(db::Failure::Closed);
                }
                db::add_file(
                    c,
                    &sid,
                    &file,
                    &uploader,
                    &name,
                    mime,
                    size,
                    crate::now() as i64,
                )
            })
            .await
        }
        Err(e) => Err(e),
    };
    if result.is_err() {
        let _ = tokio::fs::remove_file(&path).await;
    }
    result.map(Json)
}
/// Contenido de un archivo del chat: (nombre, tipo, bytes) o, en remoto, el
/// Content-Disposition que devolvió el servidor de sesiones.
async fn fetch(
    s: &App,
    h: &HeaderMap,
    id: &str,
    sid: &str,
) -> Result<(String, String, Vec<u8>, Option<String>), Error> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(Error(StatusCode::NOT_FOUND, "Archivo no disponible".into()));
    }
    let (_, _, role) = identity(s, h).await?;
    if role == "admin" && crate::remote::chat_selected(s) {
        let (mime, disposition, bytes) = crate::remote::chat_file(s, sid, id).await?;
        return Ok((
            disposition_name(&disposition),
            mime,
            bytes,
            Some(disposition),
        ));
    }
    let (key, owned) = (id.to_owned(), sid.to_owned());
    let (name, mime) = local(s, move |c| {
        if db::local(c)? != owned {
            return Err(db::Failure::Closed);
        }
        db::file(c, &owned, &key)
    })
    .await
    .map_err(|_| Error(StatusCode::NOT_FOUND, "Archivo no disponible".into()))?;
    let bytes = tokio::fs::read(s.chat_files.join(id))
        .await
        .map_err(|_| Error(StatusCode::NOT_FOUND, "Archivo no disponible".into()))?;
    Ok((name, mime, bytes, None))
}
/// Nombre original desde `filename*=UTF-8''…` de una respuesta remota.
fn disposition_name(disposition: &str) -> String {
    let Some(encoded) = disposition.split("filename*=UTF-8''").nth(1) else {
        return "archivo".into();
    };
    let bytes = encoded.split(';').next().unwrap_or("").as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out)
        .ok()
        .filter(|n| db::valid_file_name(n))
        .unwrap_or_else(|| "archivo".into())
}
pub async fn download(
    State(s): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<FileQuery>,
) -> Result<axum::response::Response, Error> {
    let (name, mime, bytes, _) = fetch(&s, &h, &id, &q.session_id).await?;
    // El tipo se vuelve a reconocer aquí: no se confía en la cabecera remota.
    let _ = mime;
    let mime =
        db::sniff(&name, &bytes[..bytes.len().min(4096)]).unwrap_or("application/octet-stream");
    Ok(db::download(&name, mime, bytes))
}
/// Solo el anfitrión: pasa una imagen del chat a la biblioteca de Archivos.
pub async fn to_library(
    State(s): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<FileQuery>,
) -> Reply {
    s.admin(&h)?;
    let (name, _, bytes, _) = fetch(&s, &h, &id, &q.session_id).await?;
    let mime = match db::sniff(&name, &bytes[..bytes.len().min(4096)]) {
        Some(m @ ("image/png" | "image/jpeg" | "image/webp")) => m,
        _ => return Err(bad("Solo las imágenes PNG, JPG o WebP pasan a Archivos")),
    };
    let asset = crate::assets::import(&s, name, mime, bytes).await?;
    Ok(Json(serde_json::json!(asset)))
}
/// Quita del disco los archivos de mensajes borrados o caducados.
pub async fn sweep(s: &App) {
    let dir = s.chat_files.clone();
    let _ = local(s, move |c| db::sweep(c, &dir)).await;
}
