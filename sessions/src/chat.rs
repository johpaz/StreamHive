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
            db::Failure::TooLarge => Error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Cada archivo puede pesar hasta 25 MB",
            ),
            db::Failure::Io(_) => Error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "No se pudo guardar el archivo",
            ),
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
    sweep(&s).await;
    Ok(Json(v))
}
#[derive(Deserialize)]
pub struct FileQuery {
    session_id: String,
}
fn file_name(h: &HeaderMap) -> Result<String> {
    h.get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| base64::engine::general_purpose::STANDARD.decode(v).ok())
        .and_then(|v| String::from_utf8(v).ok())
        .filter(|n| db::valid_file_name(n))
        .ok_or_else(|| invalid("Nombre de archivo inválido"))
}
impl App {
    pub(crate) fn chat_files(&self) -> PathBuf {
        self.config
            .database
            .parent()
            .map(|p| p.join("chat-files"))
            .unwrap_or_else(|| PathBuf::from("chat-files"))
    }
}
/// Materiales del chat: anfitrión e invitados (en directo o en espera) suben un
/// archivo y después lo envían en un mensaje con `attachment_id`.
pub async fn upload(
    State(s): State<App>,
    Query(q): Query<FileQuery>,
    req: Request,
) -> Result<Json<Value>> {
    let h = req.headers().clone();
    let name = file_name(&h)?;
    let sid = q.session_id;
    let a = actor(&s, &h, &sid).await?;
    let key = sid.clone();
    let (uploader, _, _) = s.db(move |c| check(c, &key, &a)).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let dir = s.chat_files();
    let (size, head) = db::receive(req.into_body(), &dir, &id).await?;
    let Some(mime) = db::sniff(&name, &head) else {
        let _ = tokio::fs::remove_file(dir.join(&id)).await;
        return Err(invalid(
            "Formato no admitido: PDF, imágenes, texto, CSV, Office, OpenDocument o ZIP",
        ));
    };
    let file = id.clone();
    let v = s
        .db(move |c| {
            db::ensure(c, &sid)?;
            db::add_file(c, &sid, &file, &uploader, &name, mime, size, now()).map_err(Error::from)
        })
        .await;
    if v.is_err() {
        let _ = tokio::fs::remove_file(dir.join(&id)).await;
    }
    Ok(Json(v?))
}
pub async fn download(
    State(s): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<FileQuery>,
) -> Result<Response> {
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err(missing());
    }
    let sid = q.session_id;
    let a = actor(&s, &h, &sid).await?;
    let key = id.clone();
    let (name, mime) = s
        .db(move |c| {
            check(c, &sid, &a)?;
            db::file(c, &sid, &key).map_err(|_| missing())
        })
        .await?;
    let bytes = tokio::fs::read(s.chat_files().join(&id))
        .await
        .map_err(|_| missing())?;
    Ok(db::download(&name, &mime, bytes))
}
/// Quita del disco los archivos de mensajes borrados o caducados.
pub async fn sweep(s: &App) {
    let dir = s.chat_files();
    let _ = s.db(move |c| db::sweep(c, &dir).map_err(Error::from)).await;
}
