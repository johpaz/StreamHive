mod chat;
#[path = "../../backend/src/chat_store.rs"]
mod chat_store;
pub mod media;
use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{any, delete, get, post, put},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt, stream::FusedStream};
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{broadcast, watch};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{Message, handshake::derive_accept_key, protocol::Role},
};

pub const PROTOCOL: u32 = 1;
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn secret() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}
fn hash(s: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(s.as_bytes()))
}

#[derive(Clone)]
pub struct Config {
    pub public_url: String,
    pub database: PathBuf,
    pub secure: bool,
    pub registrations_per_hour: u32,
    pub requests_per_minute: u32,
    pub max_connections: usize,
    pub trust_proxy: bool,
    /// LiveKit del compose. Sin él, el servidor solo gestiona la espera, la admisión y el chat.
    pub media: Option<media::Media>,
}
impl Config {
    pub fn new(public_url: &str, database: PathBuf) -> anyhow::Result<Self> {
        let u = url::Url::parse(public_url)?;
        anyhow::ensure!(
            u.host_str().is_some()
                && u.username().is_empty()
                && u.password().is_none()
                && u.query().is_none()
                && u.fragment().is_none()
                && u.path() == "/",
            "PUBLIC_URL must be an origin"
        );
        let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        anyhow::ensure!(
            u.scheme() == "https" || (u.scheme() == "http" && local),
            "HTTPS required except on loopback"
        );
        Ok(Self {
            public_url: u.origin().ascii_serialization(),
            database,
            secure: u.scheme() == "https",
            registrations_per_hour: 120,
            requests_per_minute: 600,
            max_connections: 1000,
            trust_proxy: false,
            media: None,
        })
    }
}
#[derive(Debug)]
pub struct Error(StatusCode, &'static str);
type Result<T> = std::result::Result<T, Error>;
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "No se pudo guardar la operación",
        )
    }
}
fn invalid(s: &'static str) -> Error {
    Error(StatusCode::BAD_REQUEST, s)
}
fn denied() -> Error {
    Error(StatusCode::UNAUTHORIZED, "Acceso no autorizado")
}
fn missing() -> Error {
    Error(StatusCode::NOT_FOUND, "Sesión o participante inexistente")
}

#[derive(Clone)]
pub struct App {
    db: Arc<Mutex<Connection>>,
    pub config: Config,
    rooms: Arc<Mutex<HashMap<String, broadcast::Sender<()>>>>,
    chat_bus: chat_store::Bus,
    hosts: Arc<Mutex<HashMap<String, usize>>>,
    /// Vista del escenario que publica el anfitrión para sus invitados admitidos (solo en memoria:
    /// la app la vuelve a enviar al reconectar).
    stages: Arc<Mutex<HashMap<String, Value>>>,
    limits: Arc<Mutex<HashMap<String, (i64, u32)>>>,
    pub connections: Arc<AtomicUsize>,
    shutdown: watch::Sender<bool>,
    media: Option<media::Media>,
}
impl App {
    pub fn open(config: Config) -> anyhow::Result<Self> {
        if let Some(p) = config.database.parent() {
            std::fs::create_dir_all(p)?;
        }
        let c = Connection::open(&config.database)?;
        let schema_version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        anyhow::ensure!(
            schema_version <= 3,
            "Database schema is newer than this service; refusing downgrade"
        );
        c.busy_timeout(Duration::from_secs(5))?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS installations(id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installations(id), created INTEGER NOT NULL, expires INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
          CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(installation_id,closed,expires);
          CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS participants(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, invitation_id TEXT NOT NULL REFERENCES invitations(id) ON DELETE CASCADE, name TEXT NOT NULL, status TEXT NOT NULL, credential_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS participants_session ON participants(session_id);
          ")?;
        chat_store::init(&c)?;
        // 3: archivos del chat (tabla chat_files y columna attachment_id).
        c.pragma_update(None, "user_version", 3)?;
        chat_store::prune(&c, now())?;
        let (shutdown, _) = watch::channel(false);
        Ok(Self {
            db: Arc::new(Mutex::new(c)),
            media: config.media.clone(),
            config,
            rooms: Default::default(),
            chat_bus: Default::default(),
            hosts: Default::default(),
            stages: Default::default(),
            limits: Default::default(),
            connections: Arc::new(AtomicUsize::new(0)),
            shutdown,
        })
    }
    async fn db<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = db.lock().map_err(|_| {
                Error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Base de datos no disponible",
                )
            })?;
            f(&mut c)
        })
        .await
        .map_err(|_| Error(StatusCode::INTERNAL_SERVER_ERROR, "Operación no disponible"))?
    }
    fn channel(&self, sid: &str) -> broadcast::Sender<()> {
        self.rooms
            .lock()
            .unwrap()
            .entry(sid.into())
            .or_insert_with(|| broadcast::channel(32).0)
            .clone()
    }
    fn notify(&self, sid: &str) {
        let _ = self.channel(sid).send(());
    }
    fn online(&self, sid: &str) -> bool {
        self.hosts.lock().unwrap().get(sid).copied().unwrap_or(0) > 0
    }
    pub fn stop(&self) {
        self.shutdown.send_replace(true);
    }
    pub async fn prune(&self) -> Result<()> {
        self.db(|c| {
            c.execute("UPDATE chat_conversations SET closed_at=(SELECT expires FROM sessions WHERE sessions.id=chat_conversations.id) WHERE closed_at IS NULL AND id IN (SELECT id FROM sessions WHERE expires<=?1)",[now()])?;
            chat_store::prune(c, now())?;
            c.execute(
                "DELETE FROM sessions WHERE expires < ?1",
                [now() - 7 * 86400],
            )?;
            Ok(())
        })
        .await?;
        chat::sweep(self).await;
        // Expired sessions terminate their sockets on the periodic authorization check.
        self.rooms
            .lock()
            .unwrap()
            .retain(|_, v| v.receiver_count() > 0);
        Ok(())
    }
    fn rate(&self, key: String, window: i64, max: u32) -> Result<()> {
        let bucket = now() / window;
        let mut limits = self.limits.lock().unwrap();
        if limits.len() > 10000 {
            limits.retain(|_, (until, _)| *until > now());
        }
        if limits.len() > 20000 {
            return Err(Error(
                StatusCode::TOO_MANY_REQUESTS,
                "Demasiadas solicitudes",
            ));
        }
        let (until, count) = limits.entry(key).or_insert((0, 0));
        if *until <= now() {
            *until = (bucket + 1) * window;
            *count = 0;
        }
        if *count >= max {
            return Err(Error(
                StatusCode::TOO_MANY_REQUESTS,
                "Demasiadas solicitudes; reintenta más tarde",
            ));
        }
        *count += 1;
        Ok(())
    }
}
fn bearer(h: &HeaderMap) -> Result<String> {
    h.get(header::AUTHORIZATION)
        .and_then(|s| s.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| s.len() <= 128)
        .map(str::to_owned)
        .ok_or_else(denied)
}
fn cookie(h: &HeaderMap) -> Option<String> {
    h.get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|v| v.trim().strip_prefix("sh_guest=").map(str::to_owned))
}
async fn owner(s: &App, h: &HeaderMap) -> Result<String> {
    let key = hash(&bearer(h)?);
    s.db(move |c| {
        c.query_row(
            "SELECT id FROM installations WHERE credential_hash=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(denied)
    })
    .await
}
fn session_owned(c: &Connection, sid: &str, oid: &str) -> Result<()> {
    if c.query_row(
        "SELECT 1 FROM sessions WHERE id=?1 AND installation_id=?2 AND closed=0 AND expires>?3",
        params![sid, oid, now()],
        |_| Ok(()),
    )
    .optional()?
    .is_some()
    {
        Ok(())
    } else {
        Err(missing())
    }
}
async fn guest(s: &App, h: &HeaderMap) -> Result<(String, String)> {
    let key = hash(&cookie(h).ok_or_else(denied)?);
    s.db(move |c| c.query_row("SELECT p.session_id,p.id FROM participants p JOIN sessions s ON s.id=p.session_id JOIN invitations i ON i.id=p.invitation_id WHERE p.credential_hash=?1 AND p.status NOT IN ('removed','rejected') AND s.closed=0 AND s.expires>?2 AND i.revoked=0 AND i.expires>?2",params![key,now()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or_else(denied)).await
}
async fn guard(State(s): State<App>, req: Request, next: Next) -> Result<Response> {
    // /lk lo usa también la app de escritorio desde su propio origen; ahí autoriza el permiso de LiveKit.
    if let Some(origin) = req
        .headers()
        .get(header::ORIGIN)
        .filter(|_| !req.uri().path().starts_with("/lk/"))
    {
        if origin.to_str().ok() != Some(&s.config.public_url) {
            return Err(Error(StatusCode::FORBIDDEN, "Origen no permitido"));
        }
    }
    let mut ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|p| p.0.ip().to_string())
        .unwrap_or_else(|| "local".into());
    if s.config.trust_proxy
        && req
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .is_some_and(|p| match p.0.ip() {
                std::net::IpAddr::V4(i) => i.is_private() || i.is_loopback(),
                std::net::IpAddr::V6(i) => i.is_loopback() || i.is_unique_local(),
            })
    {
        if let Some(v) = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.trim().parse::<std::net::IpAddr>().ok())
        {
            ip = v.to_string();
        }
    }
    if req.uri().path().starts_with("/api/") {
        s.rate(format!("requests:{ip}"), 60, s.config.requests_per_minute)?;
    }
    if req.uri().path() == "/api/v1/installations" && req.method() == "POST" {
        s.rate(
            format!("register:{ip}"),
            3600,
            s.config.registrations_per_hour,
        )?;
    }
    let mut r = next.run(req).await;
    r.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    r.headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    r.headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    r.headers_mut().insert(header::CONTENT_SECURITY_POLICY,"default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'".parse().unwrap());
    Ok(r)
}
async fn meta(State(s): State<App>) -> Json<Value> {
    let mut v = json!({"service":"streamhive-sessions","protocol":PROTOCOL,"version":env!("CARGO_PKG_VERSION"),"media":s.media.is_some(),"features":["cleanup"]});
    if let Some(m) = &s.media {
        v["media_ports"] = json!({"udp":m.ports.udp,"tcp":m.ports.tcp});
        v["media_ready"] = json!(m.ready().await);
    }
    Json(v)
}
async fn health() -> Json<Value> {
    Json(json!({"ok":true}))
}
async fn ready(State(s): State<App>) -> Result<Json<Value>> {
    s.db(|c| {
        c.query_row("SELECT 1", [], |_| Ok(()))?;
        Ok(())
    })
    .await?;
    Ok(Json(json!({"ok":true})))
}
async fn register(State(s): State<App>) -> Result<Json<Value>> {
    let oid = id();
    let credential = secret();
    let (saved, key) = (oid.clone(), hash(&credential));
    s.db(move |c| {
        if c.query_row("SELECT count(*) FROM installations", [], |r| {
            r.get::<_, u64>(0)
        })? >= 10000
        {
            return Err(Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Límite de instalaciones alcanzado",
            ));
        }
        c.execute(
            "INSERT INTO installations VALUES(?1,?2,?3)",
            params![saved, key, now()],
        )?;
        Ok(())
    })
    .await?;
    Ok(Json(
        json!({"installation_id":oid,"credential":credential,"protocol":PROTOCOL}),
    ))
}
async fn current(State(s): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let oid = owner(&s, &h).await?;
    let sid:Option<String>=s.db(move |c| Ok(c.query_row("SELECT id FROM sessions WHERE installation_id=?1 AND closed=0 AND expires>?2 ORDER BY created DESC LIMIT 1",params![oid,now()],|r|r.get(0)).optional()?)).await?;
    match sid {
        Some(sid) => snapshot(&s, &sid, None).await.map(Json),
        None => Ok(Json(json!({"session":null}))),
    }
}
async fn create_session(State(s): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let oid = owner(&s, &h).await?;
    let sid=s.db(move |c| {
        let tx=c.transaction()?;
        let existing:Option<String>=tx.query_row("SELECT id FROM sessions WHERE installation_id=?1 AND closed=0 AND expires>?2 LIMIT 1",params![oid,now()],|r|r.get(0)).optional()?;
        let sid=existing.unwrap_or_else(id);
        tx.execute("INSERT OR IGNORE INTO sessions(id,installation_id,created,expires) VALUES(?1,?2,?3,?4)",params![sid,oid,now(),now()+86400])?;
        tx.commit()?; Ok(sid)
    }).await?;
    snapshot(&s, &sid, None).await.map(Json)
}
async fn snapshot(s: &App, sid: &str, pid: Option<String>) -> Result<Value> {
    let sid = sid.to_owned();
    let online = s.online(&sid);
    let stage = if pid.is_some() {
        s.stages.lock().unwrap().get(&sid).cloned()
    } else {
        None
    };
    s.db(move |c| {
        let session=c.query_row("SELECT id,revision,expires,closed FROM sessions WHERE id=?1",[&sid],|r|Ok(json!({"id":r.get::<_,String>(0)?,"revision":r.get::<_,i64>(1)?,"expires":r.get::<_,i64>(2)?,"closed":r.get::<_,bool>(3)?,"host_online":online}))).optional()?.ok_or_else(missing)?;
        let mut q=c.prepare("SELECT id,name,status,created FROM participants WHERE session_id=?1 ORDER BY created,id")?;
        let participants=q.query_map([&sid],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"created":r.get::<_,i64>(3)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        if let Some(pid)=pid {
            // Borrado al vaciar la lista: para su página cuenta como retirado (y deja de reconectar).
            let participant=participants.into_iter().find(|p|p["id"]==pid).unwrap_or_else(||json!({"id":pid,"name":"","status":"removed"}));
            let mut out=json!({"session":session,"participant":participant});
            if out["participant"]["status"]=="admitted" && out["session"]["closed"]==false { if let Some(stage)=stage { out["stage"]=stage; } }
            return Ok(out);
        }
        let mut q=c.prepare("SELECT id,expires,revoked FROM invitations WHERE session_id=?1 ORDER BY expires")?;
        let invitations=q.query_map([&sid],|r|Ok(json!({"id":r.get::<_,String>(0)?,"expires":r.get::<_,i64>(1)?,"revoked":r.get::<_,bool>(2)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        Ok(json!({"session":session,"participants":participants,"invitations":invitations}))
    }).await
}
async fn get_session(
    State(s): State<App>,
    h: HeaderMap,
    Path(sid): Path<String>,
) -> Result<Json<Value>> {
    let oid = owner(&s, &h).await?;
    let check = sid.clone();
    s.db(move |c| session_owned(c, &check, &oid)).await?;
    snapshot(&s, &sid, None).await.map(Json)
}
async fn close_session(
    State(s): State<App>,
    h: HeaderMap,
    Path(sid): Path<String>,
) -> Result<Json<Value>> {
    let oid = owner(&s, &h).await?;
    let (key, owner_id) = (sid.clone(), oid.clone());
    s.db(move |c| { // Closing twice is safe, including after a lost response.
        let count=c.execute("UPDATE sessions SET closed=1,revision=revision+CASE WHEN closed=0 THEN 1 ELSE 0 END WHERE id=?1 AND installation_id=?2",params![key,owner_id])?;
        if count==0 {return Err(missing());} chat_store::close(c,&key,now())?; Ok(())
    }).await?;
    s.stages.lock().unwrap().remove(&sid);
    s.notify(&sid);
    if let Some(m) = &s.media {
        m.close(&oid).await;
    }
    Ok(Json(json!({"ok":true})))
}
/// Lo que el anfitrión tiene en el escenario (programa, nombres, pantalla al aire, estado del
/// directo), para que sus invitados admitidos lo vean igual. Lo arma la app de escritorio.
const STAGE_LIMIT: usize = 16384;
async fn publish_stage(
    State(s): State<App>,
    h: HeaderMap,
    Path(sid): Path<String>,
    Json(stage): Json<Value>,
) -> Result<Json<Value>> {
    let oid = owner(&s, &h).await?;
    if !stage.is_object() || stage.to_string().len() > STAGE_LIMIT {
        return Err(invalid("Vista del escenario no válida"));
    }
    let check = sid.clone();
    s.db(move |c| session_owned(c, &check, &oid)).await?;
    let changed = s.stages.lock().unwrap().insert(sid.clone(), stage.clone()) != Some(stage);
    if changed {
        s.notify(&sid);
    }
    Ok(Json(json!({"ok":true})))
}
async fn invitation(
    State(s): State<App>,
    h: HeaderMap,
    Path(sid): Path<String>,
) -> Result<Json<Value>> {
    let oid = owner(&s, &h).await?;
    let token = secret();
    let key = hash(&token);
    let iid = id();
    let expires = now() + 86400;
    let (i, room) = (iid.clone(), sid.clone());
    s.db(move |c| {
        session_owned(c, &room, &oid)?;
        let tx = c.transaction()?;
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM invitations WHERE session_id=?1",
            params![room],
            |r| r.get(0),
        )?;
        if count >= 100 {
            return Err(invalid("Máximo cien invitaciones por sesión"));
        }
        tx.execute(
            "INSERT INTO invitations VALUES(?1,?2,?3,?4,0)",
            params![i, room, key, expires],
        )?;
        tx.execute(
            "UPDATE sessions SET revision=revision+1 WHERE id=?1",
            [&room],
        )?;
        tx.commit()?;
        Ok(())
    })
    .await?;
    s.notify(&sid);
    Ok(Json(
        json!({"id":iid,"url":format!("{}/join/{token}",s.config.public_url),"expires":expires}),
    ))
}
async fn revoke(
    State(s): State<App>,
    h: HeaderMap,
    Path(iid): Path<String>,
) -> Result<Json<Value>> {
    let oid = owner(&s, &h).await?;
    let owner_id = oid.clone();
    let (sid,removed)=s.db(move |c| {
        let sid:String=c.query_row("SELECT i.session_id FROM invitations i JOIN sessions s ON s.id=i.session_id WHERE i.id=?1 AND s.installation_id=?2",params![iid,owner_id],|r|r.get(0)).optional()?.ok_or_else(missing)?;
        let removed=c.prepare("SELECT id FROM participants WHERE invitation_id=?1 AND status='admitted'")?.query_map([&iid],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let tx=c.transaction()?; tx.execute("UPDATE invitations SET revoked=1 WHERE id=?1",[&iid])?;
        tx.execute("UPDATE participants SET status='removed' WHERE invitation_id=?1",[iid])?;
        tx.execute("UPDATE sessions SET revision=revision+1 WHERE id=?1",[&sid])?; tx.commit()?; Ok((sid,removed))
    }).await?;
    s.notify(&sid);
    if let Some(m) = &s.media {
        for pid in removed {
            m.kick(&oid, &pid).await;
        }
    }
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Join {
    name: String,
}
async fn join(
    State(s): State<App>,
    h: HeaderMap,
    Path(token): Path<String>,
    Json(b): Json<Join>,
) -> Result<Response> {
    let name = b.name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 60 || name.chars().any(char::is_control) {
        return Err(invalid("Nombre: entre 1 y 60 caracteres"));
    }
    if token.len() > 128 {
        return Err(denied());
    }
    let key = hash(&token);
    let old = cookie(&h).map(|s| hash(&s));
    let credential = secret();
    let ck = hash(&credential);
    let (sid,pid)=s.db(move |c| {
        let (iid,sid):(String,String)=c.query_row("SELECT i.id,i.session_id FROM invitations i JOIN sessions s ON s.id=i.session_id WHERE i.token_hash=?1 AND i.revoked=0 AND i.expires>?2 AND s.closed=0 AND s.expires>?2",params![key,now()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or(Error(StatusCode::GONE,"La invitación caducó o fue revocada"))?;
        if let Some(old)=old { if let Some((pid,status))=c.query_row("SELECT id,status FROM participants WHERE credential_hash=?1 AND invitation_id=?2",params![old,iid],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()? {
            if status=="removed"||status=="rejected" {return Err(denied());}
            c.execute("UPDATE participants SET credential_hash=?1 WHERE id=?2",params![ck,pid])?; return Ok((sid,pid));
        }}
        let count:i64=c.query_row("SELECT count(*) FROM participants WHERE session_id=?1 AND status='waiting'",[&sid],|r|r.get(0))?;
        if count>=20 {return Err(Error(StatusCode::TOO_MANY_REQUESTS,"Sala de espera llena"));}
        let total:i64=c.query_row("SELECT count(*) FROM participants WHERE session_id=?1",[&sid],|r|r.get(0))?;
        if total>=200{return Err(Error(StatusCode::TOO_MANY_REQUESTS,"Límite de participantes de la sesión alcanzado"));}
        let pid=id(); let tx=c.transaction()?; tx.execute("INSERT INTO participants VALUES(?1,?2,?3,?4,'waiting',?5,?6)",params![pid,sid,iid,name,ck,now()])?; tx.execute("UPDATE sessions SET revision=revision+1 WHERE id=?1",[&sid])?; tx.commit()?; Ok((sid,pid))
    }).await?;
    s.notify(&sid);
    let secure = if s.config.secure { "; Secure" } else { "" };
    Ok((
        [(
            header::SET_COOKIE,
            format!(
                "sh_guest={credential}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400{secure}"
            ),
        )],
        Json(json!({"session_id":sid,"participant_id":pid})),
    )
        .into_response())
}
async fn resume(
    State(s): State<App>,
    h: HeaderMap,
    Path(token): Path<String>,
) -> Result<Json<Value>> {
    if token.len() > 128 {
        return Err(denied());
    }
    let (sid, pid) = guest(&s, &h).await?;
    let key = hash(&token);
    let check = pid.clone();
    s.db(move |c| { if c.query_row("SELECT 1 FROM participants p JOIN invitations i ON i.id=p.invitation_id WHERE p.id=?1 AND i.token_hash=?2",params![check,key],|_|Ok(())).optional()?.is_none(){return Err(denied());}Ok(()) }).await?;
    snapshot(&s, &sid, Some(pid)).await.map(Json)
}
async fn guest_state(State(s): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let (sid, pid) = guest(&s, &h).await?;
    snapshot(&s, &sid, Some(pid)).await.map(Json)
}
#[derive(Deserialize)]
struct Action {
    action: String,
}
async fn decide(
    State(s): State<App>,
    h: HeaderMap,
    Path((sid, pid)): Path<(String, String)>,
    Json(b): Json<Action>,
) -> Result<Json<Value>> {
    let status = match b.action.as_str() {
        "admit" => "admitted",
        "reject" => "rejected",
        "remove" => "removed",
        _ => return Err(invalid("Acción inválida")),
    };
    let oid = owner(&s, &h).await?;
    let (key, owner_id, who) = (sid.clone(), oid.clone(), pid.clone());
    s.db(move |c| {
        session_owned(c, &key, &owner_id)?;
        let tx = c.transaction()?;
        let old: String = tx
            .query_row(
                "SELECT status FROM participants WHERE id=?1 AND session_id=?2",
                params![pid, key],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(missing)?;
        if old == status {
            return Ok(());
        }
        if status == "admitted" && old != "waiting" {
            return Err(invalid("Esta entrada fue retirada; crea otra invitación"));
        }
        tx.execute(
            "UPDATE participants SET status=?1 WHERE id=?2 AND session_id=?3",
            params![status, pid, key],
        )?;
        tx.execute("UPDATE sessions SET revision=revision+1 WHERE id=?1", [key])?;
        tx.commit()?;
        Ok(())
    })
    .await?;
    s.notify(&sid);
    // Retirado o rechazado: fuera también de la sala de cámara y audio, al momento.
    let mut kicked = true;
    if status != "admitted" {
        if let Some(m) = &s.media {
            kicked = m.kick(&oid, &who).await;
        }
    }
    Ok(Json(json!({"ok":true,"media_kick":kicked})))
}
#[derive(Deserialize)]
struct Cleanup {
    scope: String,
}
/// Limpia la lista de invitados de la sesión (los invitados cambian cada día):
/// `finished` borra rechazados, retirados e invitaciones que ya no sirven;
/// `all` saca a todos de la sala, anula todos los enlaces y deja la lista vacía.
async fn cleanup(
    State(s): State<App>,
    h: HeaderMap,
    Path(sid): Path<String>,
    Json(b): Json<Cleanup>,
) -> Result<Json<Value>> {
    let all = match b.scope.as_str() {
        "all" => true,
        "finished" => false,
        _ => return Err(invalid("Limpieza inválida")),
    };
    let oid = owner(&s, &h).await?;
    let (key, owner_id) = (sid.clone(), oid.clone());
    let (admitted, removed) = s
        .db(move |c| {
            session_owned(c, &key, &owner_id)?;
            let tx = c.transaction()?;
            let admitted = if all {
                tx.prepare("SELECT id FROM participants WHERE session_id=?1 AND status='admitted'")?
                    .query_map([&key], |r| r.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            } else {
                Vec::new()
            };
            let mut removed = if all {
                tx.execute("UPDATE invitations SET revoked=1 WHERE session_id=?1", [&key])?;
                tx.execute("DELETE FROM participants WHERE session_id=?1", [&key])?
            } else {
                tx.execute(
                    "DELETE FROM participants WHERE session_id=?1 AND status IN ('removed','rejected')",
                    [&key],
                )?
            };
            // Invitaciones muertas (revocadas o caducadas) sin nadie dentro: fuera de la lista.
            removed += tx.execute(
                "DELETE FROM invitations WHERE session_id=?1 AND (revoked=1 OR expires<=?2) AND NOT EXISTS (SELECT 1 FROM participants p WHERE p.invitation_id=invitations.id)",
                params![key, now()],
            )?;
            if removed > 0 {
                tx.execute("UPDATE sessions SET revision=revision+1 WHERE id=?1", [&key])?;
            }
            tx.commit()?;
            Ok((admitted, removed))
        })
        .await?;
    if all {
        s.stages.lock().unwrap().remove(&sid);
    }
    if removed > 0 || all {
        s.notify(&sid);
    }
    let mut kicked = true;
    if let Some(m) = &s.media {
        for pid in admitted {
            kicked &= m.kick(&oid, &pid).await;
        }
    }
    Ok(Json(json!({"ok":true,"media_kick":kicked})))
}
#[derive(Deserialize)]
struct EventsQuery {
    session_id: String,
}
async fn events(
    State(s): State<App>,
    Query(q): Query<EventsQuery>,
    mut req: Request,
) -> Result<Response> {
    let h = req.headers().clone();
    let sid = q.session_id;
    let oid = if h.contains_key(header::AUTHORIZATION) {
        Some(owner(&s, &h).await?)
    } else {
        None
    };
    let pid = if let Some(oid) = oid {
        let key = sid.clone();
        s.db(move |c| session_owned(c, &key, &oid)).await?;
        None
    } else {
        if h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(&s.config.public_url) {
            return Err(denied());
        }
        let (room, pid) = guest(&s, &h).await?;
        if room != sid {
            return Err(denied());
        }
        Some(pid)
    };
    if h.get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| !v.eq_ignore_ascii_case("websocket"))
        || h.get("sec-websocket-version").and_then(|v| v.to_str().ok()) != Some("13")
    {
        return Err(invalid("WebSocket requerido"));
    }
    let accept = derive_accept_key(
        h.get("sec-websocket-key")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(denied)?
            .as_bytes(),
    );
    if s.connections
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < s.config.max_connections).then_some(n + 1)
        })
        .is_err()
    {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Límite de conexiones alcanzado",
        ));
    }
    let upgrade = hyper::upgrade::on(&mut req);
    let mut rx = s.channel(&sid).subscribe();
    let mut chat_rx = s.chat_bus.0.subscribe();
    let mut stop = s.shutdown.subscribe();
    tokio::spawn(async move {
        let run = async {
            let stream = tokio::time::timeout(Duration::from_secs(10), upgrade)
                .await
                .ok()
                .and_then(|r| r.ok());
            let Some(stream) = stream else {
                return;
            };
            let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
                .read_buffer_size(4096)
                .write_buffer_size(4096)
                .max_write_buffer_size(131072)
                .max_message_size(Some(16384))
                .max_frame_size(Some(16384));
            let mut ws = WebSocketStream::from_raw_socket(
                hyper_util::rt::TokioIo::new(stream),
                Role::Server,
                Some(config),
            )
            .await;
            let host = pid.is_none();
            if host {
                *s.hosts.lock().unwrap().entry(sid.clone()).or_default() += 1;
                s.notify(&sid);
            }
            let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
            let mut seen = tokio::time::Instant::now();
            loop {
                let state = snapshot(&s, &sid, pid.clone()).await;
                if let Ok(state) = state {
                    let terminal = state["session"]["closed"] == true
                        || state["session"]["expires"]
                            .as_i64()
                            .is_none_or(|t| t <= now())
                        || state["participant"]["status"] == "removed"
                        || state["participant"]["status"] == "rejected";
                    if !matches!(
                        tokio::time::timeout(
                            Duration::from_secs(5),
                            ws.send(Message::Text(
                                json!({"type":"snapshot","data":state}).to_string().into()
                            ))
                        )
                        .await,
                        Ok(Ok(()))
                    ) {
                        break;
                    }
                    if terminal {
                        break;
                    }
                } else {
                    break;
                }
                let mut changed = false;
                while !changed {
                    tokio::select! {
                        _=stop.changed()=>{let _=tokio::time::timeout(Duration::from_secs(2),ws.close(None)).await;changed=true;},
                        event=chat_rx.recv()=>{
                            let value=event.unwrap_or_else(|_|json!({"type":"chat.sync","conversation_id":sid}));
                            if value["conversation_id"]==sid && chat::authorized(&s,&h,&sid).await.is_ok() {
                                if !matches!(tokio::time::timeout(Duration::from_secs(5),ws.send(Message::Text(value.to_string().into()))).await,Ok(Ok(()))){changed=true;}
                            }
                        },
                        e=rx.recv()=>{if matches!(e,Err(broadcast::error::RecvError::Closed)){let _=tokio::time::timeout(Duration::from_secs(2),ws.close(None)).await;}changed=true;},
                        msg=ws.next()=>match msg {Some(Ok(Message::Pong(_)|Message::Ping(_)))=>seen=tokio::time::Instant::now(),Some(Ok(Message::Text(_)))=>seen=tokio::time::Instant::now(),_=>{changed=true;let _=tokio::time::timeout(Duration::from_secs(2),ws.close(None)).await;}},
                        _=heartbeat.tick()=>{if seen.elapsed()>Duration::from_secs(90)||!matches!(tokio::time::timeout(Duration::from_secs(5),ws.send(Message::Ping(Vec::new().into()))).await,Ok(Ok(()))){let _=tokio::time::timeout(Duration::from_secs(2),ws.close(None)).await;changed=true;}else{changed=true;}}
                    }
                    if *stop.borrow() || ws.is_terminated() {
                        break;
                    }
                }
                if *stop.borrow() || ws.is_terminated() {
                    break;
                }
            }
            if host {
                let mut hosts = s.hosts.lock().unwrap();
                if let Some(n) = hosts.get_mut(&sid) {
                    *n = n.saturating_sub(1);
                    if *n == 0 {
                        hosts.remove(&sid);
                    }
                }
                drop(hosts);
                s.notify(&sid);
            }
        };
        run.await;
        s.connections.fetch_sub(1, Ordering::SeqCst);
    });
    Ok(Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, "websocket")
        .header("sec-websocket-accept", accept)
        .body(Body::empty())
        .unwrap())
}

pub fn router(s: App) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(ready))
        .route("/api/v1/meta", get(meta))
        .route(
            "/api/v1/openapi.json",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    include_str!("../openapi.json"),
                )
            }),
        )
        .route("/api/v1/installations", post(register))
        .route(
            "/api/v1/sessions/current",
            get(current).post(create_session),
        )
        .route("/api/v1/sessions/{sid}", get(get_session))
        .route("/api/v1/sessions/{sid}/close", post(close_session))
        .route("/api/v1/sessions/{sid}/invitations", post(invitation))
        .route("/api/v1/sessions/{sid}/stage", put(publish_stage))
        .route("/api/v1/invitations/{iid}", delete(revoke))
        .route("/api/v1/sessions/{sid}/participants/{pid}", post(decide))
        .route("/api/v1/sessions/{sid}/cleanup", post(cleanup))
        .route("/api/v1/join/{token}", post(join).get(resume))
        .route("/api/v1/guest", get(guest_state))
        .route("/api/v1/guest/media", get(media::guest_token))
        .route("/api/v1/media/token", post(media::token))
        .route("/lk/{*rest}", any(media::proxy))
        .route("/api/v1/events", get(events))
        .route("/api/v1/chat/messages", get(chat::history).post(chat::send))
        .route("/api/v1/chat/messages/{id}", delete(chat::delete))
        .route("/api/v1/chat/files", post(chat::upload))
        .route("/api/v1/chat/files/{id}", get(chat::download))
        .route(
            "/",
            get(|| async { Html(include_str!("../web/index.html")) }),
        )
        .route(
            "/join/{token}",
            get(|| async { Html(include_str!("../web/index.html")) }),
        )
        .route(
            "/guest.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../web/guest.js"),
                )
            }),
        )
        .route(
            "/chat.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("../web/chat.css"),
                )
            }),
        )
        .route(
            "/livekit-client.umd.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../web/livekit-client.umd.js"),
                )
            }),
        )
        .route(
            "/studio.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("../web/studio.css"),
                )
            }),
        )
        .route(
            "/guest.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("../web/guest.css"),
                )
            }),
        )
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(DefaultBodyLimit::max(16384))
        .layer(middleware::from_fn_with_state(s.clone(), guard))
        .with_state(s)
}

#[cfg(test)]
mod tests;
