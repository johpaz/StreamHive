mod assets;
mod livekit;
mod model;
mod monitor;
mod output;
mod remote;
mod security;
mod store;
mod tls;

use argon2::{
    Argon2, PasswordHasher, PasswordVerifier,
    password_hash::{PasswordHash, SaltString, rand_core::OsRng},
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use base64::Engine;
use model::*;
use security::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};
use tokio::sync::{Mutex, broadcast};

#[derive(Clone)]
struct App {
    data: Arc<Mutex<Data>>,
    store: Arc<StdMutex<store::Store>>,
    events: broadcast::Sender<()>,
    operations: Arc<Mutex<()>>,
    lk: livekit::LiveKit,
    engine: output::Engine,
    monitor: monitor::Monitor,
    /// Tope absoluto de invitados admitidos; el límite real lo marca el hardware (monitor::admission).
    max_guests: usize,
    /// CA local (PEM) que los invitados deben instalar para confiar en el HTTPS de la red.
    ca_pem: Option<Arc<String>>,
    /// Hash del token de entrada automática de la app de escritorio (None = desactivado).
    desktop_token_hash: Option<String>,
    desktop_renderer: Arc<StdMutex<Option<(String, String)>>>,
    remote: Arc<remote::Remote>,
    origin: String,
    /// Orígenes adicionales aceptados (LAN / túnel) además de `origin`.
    extra_origins: Vec<String>,
    /// Base de los enlaces de invitación (por defecto `origin`).
    invite_origin: String,
    renderer_base: String,
    session_secret: String,
    master: Vec<u8>,
    admin_hash: String,
    video_bitrate: u32,
    audio_bitrate: u32,
    recordings: PathBuf,
    assets: PathBuf,
    secure_cookie: bool,
    login_attempts: Arc<Mutex<(u64, u32)>>,
}
#[derive(Debug)]
struct Error(StatusCode, String);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.1)
    }
}
impl std::error::Error for Error {}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error=%e,"operation failed");
        Self(
            StatusCode::BAD_GATEWAY,
            "La operación no pudo completarse. Revisa el estado de los servicios.".into(),
        )
    }
}
type Reply = Result<Json<Value>, Error>;
fn bad(s: &str) -> Error {
    Error(StatusCode::BAD_REQUEST, s.into())
}
fn denied() -> Error {
    Error(StatusCode::UNAUTHORIZED, "Acceso no autorizado".into())
}
impl App {
    fn admitted_cap(&self, d: &Data) -> usize {
        d.admitted_limit
            .unwrap_or(self.max_guests)
            .min(self.max_guests)
    }
    /// URL de señalización de LiveKit para este cliente. Con `LIVEKIT_PUBLIC_URL=auto` (modo escritorio)
    /// cuelga del mismo origen que el estudio (`/lk`, ver `livekit_proxy`): así funciona igual en
    /// http://localhost, en HTTPS de la LAN o tras un túnel, sin contenido mixto ni puertos extra.
    fn livekit_url(&self, h: &HeaderMap) -> String {
        if self.lk.public_url != "auto" {
            return self.lk.public_url.clone();
        }
        let host = h
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("localhost");
        let secure = std::iter::once(&self.origin)
            .chain(self.extra_origins.iter())
            .find(|o| o.split("://").nth(1) == Some(host))
            .is_some_and(|o| o.starts_with("https://"));
        format!("{}://{host}/lk", if secure { "wss" } else { "ws" })
    }
    fn origin_allowed(&self, h: &HeaderMap) -> bool {
        h.get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|o| o == self.origin || self.extra_origins.iter().any(|x| x == o))
    }
    fn required_space(&self) -> u64 {
        if self.engine.is_local() {
            return 2_000_000_000;
        }
        10_000_000_000u64.max(
            (self.video_bitrate as u64 + self.audio_bitrate as u64) * 1000 * 7200 / 8
                + 1_000_000_000,
        )
    }
    /// Carpeta donde se escriben las grabaciones nuevas.
    fn recordings_dir(&self, d: &Data) -> PathBuf {
        d.recordings_dir
            .as_ref()
            .map_or_else(|| self.recordings.clone(), PathBuf::from)
    }
    fn persist(&self, d: &mut Data) -> Result<(), Error> {
        let store = self.store.lock().unwrap();
        if let Err(error) = store.save(d) {
            if let Ok(previous) = store.load() {
                *d = previous;
            }
            return Err(Error::from(error));
        }
        let _ = self.events.send(());
        Ok(())
    }
    fn auth(&self, h: &HeaderMap) -> Result<Claims, Error> {
        let cookie = h
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let token = cookie
            .split(';')
            .filter_map(|s| s.trim().split_once('='))
            .find(|(k, _)| *k == "sh_session")
            .map(|(_, v)| v)
            .ok_or_else(denied)?;
        verify(&self.session_secret, token).map_err(|_| denied())
    }
    fn admin(&self, h: &HeaderMap) -> Result<(), Error> {
        if self.auth(h)?.role != "admin" {
            return Err(denied());
        }
        Ok(())
    }
    fn cookie(&self, token: &str, max_age: u64) -> String {
        format!(
            "sh_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}{}",
            if self.secure_cookie { "; Secure" } else { "" }
        )
    }
    async fn participant(&self, h: &HeaderMap) -> Result<Claims, Error> {
        let c = self.auth(h)?;
        if c.role != "admin" {
            let d = self.data.lock().await;
            let p = d.participants.get(&c.sub).ok_or_else(denied)?;
            if p.status == "removed" {
                return Err(denied());
            }
        }
        Ok(c)
    }
    async fn render_access(&self, token: &str) -> Result<(), Error> {
        let d = self.data.lock().await;
        if !d.active().is_some_and(|b| b.renderer_hash == hash(token)) {
            return Err(denied());
        }
        Ok(())
    }
}
async fn csrf(State(s): State<App>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if !matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
    ) && path != "/api/v1/webhook"
        && path != "/api/v1/renderer/ack"
    {
        if !s.origin_allowed(req.headers()) {
            return Error(StatusCode::FORBIDDEN, "Origen no permitido".into()).into_response();
        }
    }
    next.run(req).await
}
#[derive(Deserialize)]
struct Login {
    password: String,
}
async fn login(State(s): State<App>, Json(body): Json<Login>) -> Result<Response, Error> {
    {
        let mut attempts = s.login_attempts.lock().await;
        if now().saturating_sub(attempts.0) > 60 {
            *attempts = (now(), 0)
        }
        attempts.1 += 1;
        if attempts.1 > 20 {
            return Err(Error(
                StatusCode::TOO_MANY_REQUESTS,
                "Demasiados intentos; espera un minuto".into(),
            ));
        }
    }
    let encoded = s.admin_hash.clone();
    let password = body.password;
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&encoded).ok().is_some_and(|p| {
            Argon2::default()
                .verify_password(password.as_bytes(), &p)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false);
    if !valid {
        return Err(denied());
    }
    Ok((
        [(
            header::SET_COOKIE,
            s.cookie(&session(&s.session_secret, "host", "admin"), 43200),
        )],
        Json(json!({"ok":true})),
    )
        .into_response())
}
#[derive(Deserialize)]
struct DesktopEnter {
    token: String,
}
/// Entrada automática de la app de escritorio: su proceso principal conoce un token aleatorio de
/// 256 bits (generado en cada arranque y entregado solo al backend que lanza) y lo canjea por la
/// sesión de administrador. Sin token configurado (servidor, Docker, modo LAN) no existe.
async fn desktop_enter(
    State(s): State<App>,
    Query(q): Query<DesktopEnter>,
) -> Result<Response, Error> {
    let Some(expected) = s.desktop_token_hash.as_ref() else {
        return Err(denied());
    };
    {
        let mut attempts = s.login_attempts.lock().await;
        if now().saturating_sub(attempts.0) > 60 {
            *attempts = (now(), 0)
        }
        attempts.1 += 1;
        if attempts.1 > 20 {
            return Err(Error(
                StatusCode::TOO_MANY_REQUESTS,
                "Demasiados intentos; espera un minuto".into(),
            ));
        }
    }
    if &hash(&q.token) != expected {
        return Err(denied());
    }
    Ok((
        StatusCode::NO_CONTENT,
        [(
            header::SET_COOKIE,
            s.cookie(&session(&s.session_secret, "host", "admin"), 43200),
        )],
    )
        .into_response())
}
/// Proxy de la señalización de LiveKit (solo rutas `rtc*`): WebSocket y `/rtc/validate`.
/// La media (UDP/TCP de ICE) no pasa por aquí: el cliente la envía directo al equipo anfitrión.
async fn livekit_proxy(
    State(s): State<App>,
    Path(rest): Path<String>,
    mut req: Request,
) -> Result<Response, Error> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        WebSocketStream, connect_async,
        tungstenite::{Message, handshake::derive_accept_key, protocol::Role},
    };
    if !(rest == "rtc" || rest.starts_with("rtc/")) {
        return Err(Error(StatusCode::NOT_FOUND, "No encontrado".into()));
    }
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let upstream = format!("{}/{rest}{query}", s.lk.endpoint.trim_end_matches('/'));
    let h = req.headers().clone();
    let is_ws = h
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    if !is_ws {
        let r =
            s.lk.client
                .get(&upstream)
                .send()
                .await
                .map_err(|e| Error(StatusCode::BAD_GATEWAY, e.to_string()))?;
        let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let body = r
            .bytes()
            .await
            .map_err(|e| Error(StatusCode::BAD_GATEWAY, e.to_string()))?;
        return Ok((status, body).into_response());
    }
    let key = h
        .get("sec-websocket-key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| bad("WebSocket key missing"))?;
    let accept = derive_accept_key(key.as_bytes());
    let ws_url = upstream.replacen("http", "ws", 1);
    let (up, _) = connect_async(ws_url)
        .await
        .map_err(|e| Error(StatusCode::BAD_GATEWAY, e.to_string()))?;
    let upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        let Ok(stream) = upgrade.await else { return };
        let down = WebSocketStream::from_raw_socket(
            hyper_util::rt::TokioIo::new(stream),
            Role::Server,
            None,
        )
        .await;
        let (mut dtx, mut drx) = down.split();
        let (mut utx, mut urx) = up.split();
        let a = async {
            while let Some(Ok(m)) = drx.next().await {
                if matches!(m, Message::Close(_)) || utx.send(m).await.is_err() {
                    break;
                }
            }
        };
        let b = async {
            while let Some(Ok(m)) = urx.next().await {
                if matches!(m, Message::Close(_)) || dtx.send(m).await.is_err() {
                    break;
                }
            }
        };
        tokio::select! { _ = a => {}, _ = b => {} }
    });
    Ok(Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, "websocket")
        .header("sec-websocket-accept", accept)
        .body(axum::body::Body::empty())
        .unwrap())
}
async fn ca_pem(State(s): State<App>) -> Result<Response, Error> {
    let pem = s
        .ca_pem
        .as_ref()
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "HTTPS local no activado".into()))?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/x-pem-file"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"StreamHive-CA.pem\"",
            ),
        ],
        pem.as_str().to_owned(),
    )
        .into_response())
}
async fn logout(State(s): State<App>) -> Response {
    (
        [(header::SET_COOKIE, s.cookie("", 0))],
        Json(json!({"ok":true})),
    )
        .into_response()
}
async fn me(State(s): State<App>, h: HeaderMap) -> Reply {
    let c = s.participant(&h).await?;
    Ok(Json(
        json!({"id":c.sub,"role":c.role,"livekit_url":s.livekit_url(&h)}),
    ))
}
async fn health() -> Json<Value> {
    Json(json!({"ok":true,"version":env!("CARGO_PKG_VERSION")}))
}
fn destination_state(d: &Data, x: &StoredDestination) -> String {
    if !x.enabled {
        return "disabled".into();
    }
    d.active()
        .and_then(|b| b.destination_statuses.get(&x.id))
        .cloned()
        .unwrap_or_else(|| {
            if d.active().is_some_and(|b| b.live) {
                "connecting"
            } else {
                "ready"
            }
            .into()
        })
}
fn snapshot(d: &Data) -> Value {
    json!({"program":d.program,"portrait_program":d.portrait_program,"scenes":d.scenes,
        "participants":d.participants.values().map(|p|json!({"id":p.id,"name":p.name,"status":p.status,"connected":p.connected})).collect::<Vec<_>>(),
        "broadcast":d.broadcasts.last(),"destination_configured":d.destinations.iter().any(|x|x.enabled),
        "destinations":d.destinations.iter().map(|x|json!({"id":x.id,"name":x.name,"platform":x.platform,"enabled":x.enabled,"format":x.format,"status":destination_state(d,x)})).collect::<Vec<_>>(),
        "assets":d.assets.values().collect::<Vec<_>>(),"server_time_ms":now_ms(),
        "slates":d.slates,"active_slate":d.active_slate})
}
async fn studio(State(s): State<App>, h: HeaderMap) -> Reply {
    s.participant(&h).await?;
    let d = s.data.lock().await;
    let mut v = snapshot(&d);
    v["limits"] = json!({"on_screen":d.on_screen_cap(),"admitted":s.admitted_cap(&d),"max_admitted":s.max_guests});
    if let Some(b) = v.get_mut("broadcast").and_then(|v| v.as_object_mut()) {
        b.remove("renderer_hash");
    }
    v["independent_services"] = json!(s.engine.independent_services());
    Ok(Json(v))
}
async fn status(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let dir = s.recordings_dir(&*s.data.lock().await);
    // Una carpeta no disponible (disco extraído) no debe tumbar el estado del servidor.
    let bytes = fs2::available_space(&dir)
        .or_else(|_| fs2::available_space(&s.recordings))
        .map_err(|e| Error::from(anyhow::Error::new(e)))?;
    let lk =
        s.lk.rpc("RoomService", "ListRooms", json!({"names":[ROOM]}))
            .await
            .is_ok();
    Ok(Json(
        json!({"free_bytes":bytes,"disk_warning":bytes<s.required_space(),"livekit":lk,"database":true}),
    ))
}
async fn invite(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let token = random();
    let item = Invitation {
        id: id(),
        hash: hash(&token),
        expires: now() + 86400,
        revoked: false,
    };
    let result = json!({"id":item.id,"url":format!("{}/join/{token}",s.invite_origin),"expires":item.expires,
        "ca_url":s.ca_pem.as_ref().map(|_| format!("{}/ca.pem",s.invite_origin))});
    let mut d = s.data.lock().await;
    d.invitations.insert(item.id.clone(), item);
    s.persist(&mut d)?;
    Ok(Json(result))
}
async fn invitations(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let d = s.data.lock().await;
    Ok(Json(json!(
        d.invitations
            .values()
            .map(|x| json!({"id":x.id,"expires":x.expires,"revoked":x.revoked}))
            .collect::<Vec<_>>()
    )))
}
async fn revoke(State(s): State<App>, h: HeaderMap, Path(i): Path<String>) -> Reply {
    s.admin(&h)?;
    let mut d = s.data.lock().await;
    d.invitations
        .get_mut(&i)
        .ok_or_else(|| bad("Invitación inexistente"))?
        .revoked = true;
    s.persist(&mut d)?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Join {
    token: String,
    name: String,
}
async fn join(State(s): State<App>, Json(body): Json<Join>) -> Result<Response, Error> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(bad("Nombre: entre 1 y 60 caracteres"));
    }
    let mut d = s.data.lock().await;
    let invitation = d
        .invitations
        .values()
        .find(|i| i.hash == hash(&body.token) && !i.revoked && i.expires > now())
        .ok_or_else(denied)?
        .id
        .clone();
    if d.participants
        .values()
        .filter(|x| x.status == "waiting")
        .count()
        >= 20
    {
        return Err(bad("Sala de espera llena"));
    }
    let identity = id();
    d.participants.insert(
        identity.clone(),
        Participant {
            id: identity.clone(),
            name: name.into(),
            status: "waiting".into(),
            invite: invitation,
            created: now(),
            connected: false,
        },
    );
    s.persist(&mut d)?;
    Ok((
        [(
            header::SET_COOKIE,
            s.cookie(&session(&s.session_secret, &identity, "guest"), 43200),
        )],
        Json(json!({"id":identity})),
    )
        .into_response())
}
async fn token(State(s): State<App>, h: HeaderMap) -> Reply {
    let c = s.participant(&h).await?;
    let d = s.data.lock().await;
    let name = if c.role == "admin" {
        "Anfitrión"
    } else {
        let p = d.participants.get(&c.sub).ok_or_else(denied)?;
        if p.status != "admitted" {
            return Err(Error(
                StatusCode::FORBIDDEN,
                "Espera a que te admita el anfitrión".into(),
            ));
        }
        &p.name
    };
    Ok(Json(
        json!({"token":s.lk.join_token(&c.sub,name),"url":s.livekit_url(&h)}),
    ))
}
#[derive(Deserialize)]
struct Action {
    action: String,
}
async fn participant_action(
    State(s): State<App>,
    h: HeaderMap,
    Path(identity): Path<String>,
    Json(body): Json<Action>,
) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    if !["admit", "wait", "remove", "mute"].contains(&body.action.as_str()) {
        return Err(bad("Acción desconocida"));
    }
    {
        let d = s.data.lock().await;
        if !d.participants.contains_key(&identity) && !(identity == "host" && body.action == "mute")
        {
            return Err(bad("Participante inexistente"));
        }
    }
    if body.action == "mute" {
        let info =
            s.lk.rpc(
                "RoomService",
                "GetParticipant",
                json!({"room":ROOM,"identity":identity}),
            )
            .await?;
        for track in info["tracks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| t["source"] == "MICROPHONE" || t["source"] == 2)
        {
            s.lk.rpc(
                "RoomService",
                "MutePublishedTrack",
                json!({"room":ROOM,"identity":identity,"track_sid":track["sid"],"muted":true}),
            )
            .await?;
        }
    } else {
        // Revoke authorization before kicking, so no replacement token can be minted.
        let was_admitted;
        {
            let mut d = s.data.lock().await;
            was_admitted = d.participants[&identity].status == "admitted";
            if body.action == "admit" {
                let p = &d.participants[&identity];
                let inv = d.invitations.get(&p.invite).ok_or_else(denied)?;
                if inv.revoked || inv.expires <= now() {
                    return Err(bad("La invitación ha caducado o fue revocada"));
                }
                if !was_admitted {
                    let admitted = d
                        .participants
                        .values()
                        .filter(|p| p.status == "admitted")
                        .count();
                    let cap = s.admitted_cap(&d);
                    // Sin cupo propio decide el límite del servidor, más abajo.
                    if d.admitted_limit.is_some() && admitted >= cap {
                        return Err(bad(&format!(
                            "Cupo de invitados completo ({cap}): súbelo o saca a alguien de la sala"
                        )));
                    }
                    let live = d.active().is_some_and(|b| b.status == "live");
                    monitor::admission(
                        s.monitor.snapshot().0.as_ref(),
                        admitted,
                        s.max_guests,
                        s.engine.stats().as_ref(),
                        live,
                    )
                    .map_err(|m| bad(&m))?;
                }
            }
            let p = d.participants.get_mut(&identity).unwrap();
            p.status = match body.action.as_str() {
                "admit" => "admitted",
                "wait" => "waiting",
                _ => "removed",
            }
            .into();
            if body.action != "admit" {
                p.connected = false;
                d.remove_from_program(&identity)
            }
            s.persist(&mut d)?;
        }
        if was_admitted && body.action != "admit" {
            s.lk.remove(&identity).await?;
        }
    }
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize, Default)]
struct FormatQuery {
    #[serde(default)]
    format: OutputFormat,
}
#[derive(Deserialize)]
struct SaveScene {
    name: String,
    #[serde(default)]
    format: OutputFormat,
}
async fn scene_save(State(s): State<App>, h: HeaderMap, Json(body): Json<SaveScene>) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    if d.scenes.len() >= 20 {
        return Err(bad("Máximo veinte escenas guardadas"));
    }
    let scene = Scene {
        id: id(),
        name: clean_name(&body.name)?,
        format: body.format,
        program: d.program_for(body.format).clone(),
    };
    d.scenes.push(scene.clone());
    s.persist(&mut d)?;
    Ok(Json(json!(scene)))
}
/// Sustituye el contenido de una escena por el programa actual de su formato.
async fn scene_update(State(s): State<App>, h: HeaderMap, Path(id): Path<String>) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    let format = d
        .scenes
        .iter()
        .find(|x| x.id == id)
        .map(|x| x.format)
        .ok_or_else(|| bad("Escena inexistente"))?;
    let program = d.program_for(format).clone();
    let scene = d.scenes.iter_mut().find(|x| x.id == id).unwrap();
    scene.program = program;
    let scene = scene.clone();
    s.persist(&mut d)?;
    Ok(Json(json!(scene)))
}
async fn scene_activate(State(s): State<App>, h: HeaderMap, Path(id): Path<String>) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    let scene = d
        .scenes
        .iter()
        .find(|x| x.id == id)
        .cloned()
        .ok_or_else(|| bad("Escena inexistente"))?;
    let mut p = scene.program;
    p.revision = d.program_for(scene.format).revision;
    if p.identities.len() > d.on_screen_cap() {
        return Err(bad(&format!(
            "La escena tiene {} cámaras y el cupo en pantalla es {}",
            p.identities.len(),
            d.on_screen_cap()
        )));
    }
    d.validate_program_for(&p, scene.format).map_err(bad)?;
    p.revision += 1;
    // Restart a saved clip from its stored position, never from an old wall-clock timestamp.
    p.playback.started_at_ms = p.playback.playing.then_some(now_ms());
    *d.program_for_mut(scene.format) = p;
    s.persist(&mut d)?;
    Ok(Json(json!({"ok":true,"format":scene.format})))
}
async fn scene_remove(State(s): State<App>, h: HeaderMap, Path(id): Path<String>) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    let previous = d.scenes.len();
    d.scenes.retain(|x| x.id != id);
    if previous == d.scenes.len() {
        return Err(bad("Escena inexistente"));
    }
    s.persist(&mut d)?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Limits {
    on_screen: usize,
    admitted: usize,
}
async fn limits_update(State(s): State<App>, h: HeaderMap, Json(body): Json<Limits>) -> Reply {
    s.admin(&h)?;
    if !(1..=MAX_ON_SCREEN).contains(&body.on_screen) {
        return Err(bad("El cupo en pantalla admite de 1 a 6 cámaras"));
    }
    if body.admitted > s.max_guests {
        return Err(bad(&format!(
            "Este servidor admite hasta {} invitados",
            s.max_guests
        )));
    }
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    d.on_screen_limit = Some(body.on_screen);
    d.admitted_limit = Some(body.admitted);
    s.persist(&mut d)?;
    Ok(Json(json!({"ok":true})))
}
async fn slate_update(
    State(s): State<App>,
    h: HeaderMap,
    Path(kind): Path<SlateKind>,
    Json(slate): Json<Slate>,
) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    d.validate_slate(&slate).map_err(bad)?;
    *d.slates.get_mut(kind) = slate;
    s.persist(&mut d)?;
    Ok(Json(json!(d.slates.get(kind))))
}
/// Pone una pantalla al aire; si tiene temporizador, programa qué ocurre al llegar a cero.
fn show_slate(s: &App, d: &mut Data, kind: SlateKind) -> Result<(), Error> {
    let started_at_ms = now_ms();
    let seconds = d.slates.get(kind).timer_seconds;
    let active = ActiveSlate {
        kind,
        started_at_ms,
        ends_at_ms: (seconds > 0).then(|| started_at_ms + u64::from(seconds) * 1000),
    };
    d.active_slate = Some(active.clone());
    s.persist(d)?;
    if seconds > 0 {
        let worker = s.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(seconds.into())).await;
            let _guard = worker.operations.lock().await;
            if let Err(e) = finish_slate_timer(&worker, &active).await {
                tracing::warn!("no se pudo aplicar el fin del temporizador: {}", e.1);
            }
        });
    }
    Ok(())
}
/// Solo actúa si sigue al aire esa misma pantalla y tiene el modo automático activado.
/// Quien llama debe tener el bloqueo de `operations`.
async fn finish_slate_timer(s: &App, expected: &ActiveSlate) -> Result<(), Error> {
    let session = {
        let mut d = s.data.lock().await;
        if d.active_slate.as_ref() != Some(expected)
            || !d.slates.get(expected.kind).auto_on_timer_end
        {
            return Ok(());
        }
        let session = d.active().is_some();
        if expected.kind != SlateKind::End || !session {
            d.active_slate = None;
            s.persist(&mut d)?;
            return Ok(());
        }
        session
    };
    // La pantalla de fin sigue visible hasta que la sesión termina de cerrarse.
    if session {
        stop_live(s, true).await?;
    }
    Ok(())
}
async fn slate_show(State(s): State<App>, h: HeaderMap, Path(kind): Path<SlateKind>) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    show_slate(&s, &mut d, kind)?;
    Ok(Json(json!(d.active_slate)))
}
async fn slate_hide(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    d.active_slate = None;
    s.persist(&mut d)?;
    Ok(Json(json!({"ok":true})))
}
async fn program(
    State(s): State<App>,
    h: HeaderMap,
    Query(q): Query<FormatQuery>,
    Json(mut p): Json<Program>,
) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    d.validate_program_for(&p, q.format)
        .map_err(|m| Error(StatusCode::CONFLICT, m.into()))?;
    if p.media_asset != d.program_for(q.format).media_asset {
        p.playback.position = 0.0;
        p.playback.playing = false;
        p.playback.started_at_ms = None;
    }
    if p.media_asset
        .as_ref()
        .and_then(|id| d.assets.get(id))
        .is_none_or(|a| a.kind != "video")
    {
        p.playback.playing = false;
    }
    if p.playback.playing
        && (!d.program_for(q.format).playback.playing
            || p.playback.position != d.program_for(q.format).playback.position
            || p.playback.started_at_ms != d.program_for(q.format).playback.started_at_ms)
    {
        p.playback.started_at_ms = Some(now_ms());
    }
    if !p.playback.playing {
        p.playback.started_at_ms = None;
    }
    p.revision += 1;
    *d.program_for_mut(q.format) = p;
    s.persist(&mut d)?;
    Ok(Json(json!(d.program_for(q.format))))
}
#[derive(Deserialize)]
struct Destination {
    url: String,
    key: String,
}
fn destination_url(url: &str, key: &str) -> Result<String, Error> {
    let parsed = url::Url::parse(url).map_err(|_| bad("URL RTMP inválida"))?;
    if !["rtmp", "rtmps"].contains(&parsed.scheme())
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || key.trim().is_empty()
        || key.chars().any(|c| c.is_control())
    {
        return Err(bad("Introduce URL RTMP/RTMPS y clave válidas"));
    }
    let (server, query) = url
        .trim()
        .split_once('?')
        .map_or((url.trim(), ""), |(a, b)| (a, b));
    let mut value = format!(
        "{}/{}",
        server.trim_end_matches('/'),
        key.trim().trim_start_matches('/')
    );
    if !query.is_empty() {
        value.push(if value.contains('?') { '&' } else { '?' });
        value.push_str(query);
    }
    Ok(value)
}
/// Canales de emisión. YouTube, Twitch y Facebook tienen un servidor de ingesta fijo; el resto (`url: None`)
/// lo da cada cuenta o cada directo, así que el usuario pega la URL y la clave que le muestra la plataforma.
struct Preset {
    id: &'static str,
    name: &'static str,
    url: Option<&'static str>,
    help: &'static str,
}
const PRESETS: [Preset; 8] = [
    Preset {
        id: "youtube",
        name: "YouTube",
        url: Some("rtmps://a.rtmps.youtube.com:443/live2"),
        help: "Guardar la clave configura el destino. Después inicia la transmisión desde el estudio. En YouTube Studio espera la vista previa y pulsa Emitir en directo si el inicio automático está desactivado.",
    },
    Preset {
        id: "twitch",
        name: "Twitch",
        url: Some("rtmp://live.twitch.tv/app"),
        help: "",
    },
    Preset {
        id: "facebook",
        name: "Facebook",
        url: Some("rtmps://rtmp-api.facebook.com:443/rtmp/"),
        help: "",
    },
    Preset {
        id: "kick",
        name: "Kick",
        url: None,
        help: "Copia la URL del servidor y la clave de transmisión del panel de emisión de tu canal de Kick. La URL es propia de tu canal.",
    },
    Preset {
        id: "x",
        name: "X",
        url: None,
        help: "Copia la URL RTMP y la clave del panel de emisión en directo de X. Tu cuenta debe tener acceso a transmitir en directo.",
    },
    Preset {
        id: "instagram",
        name: "Instagram",
        url: None,
        help: "Instagram da la URL y la clave de cada directo (Live Producer) y pueden cambiar en cada emisión. Tu cuenta debe poder emitir por RTMP.",
    },
    Preset {
        id: "tiktok",
        name: "TikTok",
        url: None,
        help: "TikTok da la URL y la clave desde sus herramientas de LIVE. Dependen de tu cuenta, que debe tener acceso a emitir por RTMP.",
    },
    Preset {
        id: "linkedin",
        name: "LinkedIn",
        url: None,
        help: "En LinkedIn Live, al crear el evento con transmisión personalizada, se muestran la URL y la clave. Requiere acceso a LinkedIn Live.",
    },
];
const MAX_DESTINATIONS: usize = 5;
#[cfg(test)]
fn enabled_destinations(master: &[u8], d: &Data) -> Result<Vec<String>, Error> {
    d.destinations
        .iter()
        .filter(|x| x.enabled)
        .map(|x| unseal(master, &x.sealed).map_err(Error::from))
        .collect()
}
/// Vista segura de los destinos: nunca incluye la clave; el host sirve para reconocerlos en la lista.
fn destinations_view(master: &[u8], d: &Data) -> Vec<Value> {
    d.destinations
        .iter()
        .map(|x| {
            let host = unseal(master, &x.sealed)
                .ok()
                .and_then(|u| url::Url::parse(&u).ok())
                .and_then(|u| u.host_str().map(str::to_owned));
            json!({"id":x.id,"name":x.name,"platform":x.platform,"enabled":x.enabled,"host":host,"format":x.format,"status":destination_state(d, x)})
        })
        .collect()
}
#[derive(Deserialize)]
struct NewDestination {
    #[serde(default)]
    format: OutputFormat,
    platform: String,
    name: Option<String>,
    url: Option<String>,
    key: String,
}
#[derive(Deserialize)]
struct DestinationPatch {
    url: Option<String>,
    key: Option<String>,
    format: Option<OutputFormat>,
    enabled: Option<bool>,
    name: Option<String>,
}
fn clean_name(name: &str) -> Result<String, Error> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 40 || n.chars().any(|c| c.is_control()) {
        return Err(bad("El nombre debe tener entre 1 y 40 caracteres"));
    }
    Ok(n.to_owned())
}
async fn destinations_list(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let d = s.data.lock().await;
    Ok(Json(json!({
        "destinations":destinations_view(&s.master,&d),
        "presets":PRESETS.iter().map(|p|json!({"id":p.id,"name":p.name,"needs_url":p.url.is_none(),"help":p.help})).collect::<Vec<_>>(),
        "max":MAX_DESTINATIONS,
        "profiles": ([OutputFormat::Landscape,OutputFormat::Portrait].map(|f| { let (video,audio)=output_profile(&d,f,s.video_bitrate,s.audio_bitrate); json!({"format":f,"video_bitrate":video,"audio_bitrate":audio,"fps":30}) }))
    })))
}
async fn destination_add(
    State(s): State<App>,
    h: HeaderMap,
    Json(b): Json<NewDestination>,
) -> Reply {
    s.admin(&h)?;
    let (name, url) = match PRESETS.iter().find(|p| p.id == b.platform) {
        Some(p) => (
            b.name
                .as_deref()
                .map_or(Ok(p.name.to_owned()), clean_name)?,
            match p.url {
                Some(fixed) => b
                    .url
                    .clone()
                    .filter(|u| !u.trim().is_empty())
                    .unwrap_or_else(|| fixed.to_owned()),
                None => b.url.clone().ok_or_else(|| {
                    bad(&format!("Pega la URL del servidor que te da {}", p.name))
                })?,
            },
        ),
        None if b.platform == "custom" => (
            clean_name(b.name.as_deref().unwrap_or("Personalizado"))?,
            b.url
                .clone()
                .ok_or_else(|| bad("Indica la URL RTMP/RTMPS del servidor"))?,
        ),
        None => return Err(bad("Plataforma desconocida")),
    };
    let value = destination_url(&url, &b.key)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    if d.active().is_some() {
        return Err(bad("Finaliza el directo antes de cambiar los destinos"));
    }
    if d.destinations.len() >= MAX_DESTINATIONS {
        return Err(bad("Máximo de cinco destinos"));
    }
    let item = StoredDestination {
        id: id(),
        name,
        platform: b.platform,
        enabled: true,
        sealed: seal(&s.master, &value)?,
        sealed_server: Some(seal(&s.master, &url)?),
        format: b.format,
    };
    let created = json!({"id":item.id,"name":item.name,"platform":item.platform,"enabled":true,"format":item.format});
    d.destinations.push(item);
    s.persist(&mut d)?;
    Ok(Json(created))
}
async fn destination_update(
    State(s): State<App>,
    h: HeaderMap,
    Path(did): Path<String>,
    Json(b): Json<DestinationPatch>,
) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    if d.active().is_some() {
        return Err(bad("Finaliza el directo antes de cambiar los destinos"));
    }
    let name = b.name.as_deref().map(clean_name).transpose()?;
    let item = d
        .destinations
        .iter_mut()
        .find(|x| x.id == did)
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "Destino no encontrado".into()))?;
    // A credential replacement is atomic and always encrypted. Never return either secret.
    if b.url.is_some() || b.key.is_some() {
        let server = b
            .url
            .as_deref()
            .filter(|u| !u.trim().is_empty())
            .map(str::to_owned)
            .or_else(|| {
                item.sealed_server
                    .as_ref()
                    .and_then(|v| unseal(&s.master, v).ok())
            })
            .or_else(|| {
                PRESETS
                    .iter()
                    .find(|p| p.id == item.platform)
                    .and_then(|p| p.url)
                    .map(str::to_owned)
            })
            .ok_or_else(|| bad("Pega la URL del servidor para actualizar este destino antiguo"))?;
        let key = b
            .key
            .as_deref()
            .filter(|k| !k.trim().is_empty())
            .ok_or_else(|| bad("Pega la clave de transmisión para actualizar las credenciales"))?;
        let value = destination_url(&server, key)?;
        item.sealed = seal(&s.master, &value)?;
        item.sealed_server = Some(seal(&s.master, server.trim())?);
    }
    if let Some(format) = b.format {
        item.format = format;
    }
    if let Some(e) = b.enabled {
        item.enabled = e;
    }
    if let Some(n) = name {
        item.name = n;
    }
    s.persist(&mut d)?;
    Ok(Json(json!({"ok":true})))
}
async fn destination_remove(State(s): State<App>, h: HeaderMap, Path(did): Path<String>) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    if d.active().is_some() {
        return Err(bad("Finaliza el directo antes de cambiar los destinos"));
    }
    let before = d.destinations.len();
    d.destinations.retain(|x| x.id != did);
    if d.destinations.len() == before {
        return Err(Error(StatusCode::NOT_FOUND, "Destino no encontrado".into()));
    }
    s.persist(&mut d)?;
    Ok(Json(json!({"ok":true})))
}
/// Compatibilidad: `PUT /destination` sustituye la lista por un único destino personalizado.
async fn destination(State(s): State<App>, h: HeaderMap, Json(body): Json<Destination>) -> Reply {
    s.admin(&h)?;
    let value = destination_url(&body.url, &body.key)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    if d.active().is_some() {
        return Err(bad("Finaliza el directo antes de cambiar el destino"));
    }
    d.destinations = vec![StoredDestination {
        id: id(),
        name: "Principal".into(),
        platform: "custom".into(),
        enabled: true,
        sealed: seal(&s.master, &value)?,
        sealed_server: Some(seal(&s.master, &body.url)?),
        format: OutputFormat::Landscape,
    }];
    s.persist(&mut d)?;
    Ok(Json(json!({"ok":true})))
}
fn output_profile(d: &Data, format: OutputFormat, video: u32, audio: u32) -> (u32, u32) {
    let facebook = d
        .destinations
        .iter()
        .any(|x| x.enabled && x.format == format && x.platform == "facebook");
    let twitch = d
        .destinations
        .iter()
        .any(|x| x.enabled && x.format == format && x.platform == "twitch");
    (
        if facebook || twitch {
            video.min(6000)
        } else {
            video
        },
        if facebook { audio.min(128) } else { audio },
    )
}
fn output_groups(master: &[u8], d: &Data) -> Result<Vec<(OutputFormat, Vec<String>)>, Error> {
    [OutputFormat::Landscape, OutputFormat::Portrait]
        .into_iter()
        .filter_map(|format| {
            let items: Vec<_> = d
                .destinations
                .iter()
                .filter(|x| x.enabled && x.format == format)
                .collect();
            if items.is_empty() {
                None
            } else {
                Some(
                    items
                        .into_iter()
                        .map(|x| unseal(master, &x.sealed).map_err(Error::from))
                        .collect::<Result<Vec<_>, _>>()
                        .map(|urls| (format, urls)),
                )
            }
        })
        .collect()
}
#[derive(Deserialize, Default)]
struct StartQuery {
    #[serde(default)]
    record: bool,
}
#[derive(Deserialize, Default)]
struct StopQuery {
    /// Finaliza todos los servicios de la sesión.
    #[serde(default)]
    all: bool,
}
const NO_DESTINATION: &str = "Configura y activa al menos un destino de transmisión";
const FIXED_SERVICES: &str =
    "Este motor fija sus servicios al iniciar: finaliza la sesión para cambiarlos";
/// Crea la carpeta si falta y comprueba que se pueda escribir de verdad en ella.
fn prepare_recordings_dir(dir: &std::path::Path) -> Result<(), Error> {
    let unusable =
        |e: std::io::Error| bad(&format!("No se puede guardar en {}: {e}", dir.display()));
    std::fs::create_dir_all(dir).map_err(unusable)?;
    let probe = dir.join(format!(".streamhive-write-test-{}", id()));
    std::fs::write(&probe, b"").map_err(unusable)?;
    std::fs::remove_file(&probe).map_err(unusable)
}
/// Nunca se graba en otra carpeta sin avisar: si la elegida falla, se informa del error.
fn ensure_recording_space(s: &App, dir: &std::path::Path, formats: usize) -> Result<(), Error> {
    prepare_recordings_dir(dir)?;
    if fs2::available_space(dir).map_err(|e| Error::from(anyhow::Error::new(e)))?
        < s.required_space() * formats as u64
    {
        return Err(bad("Espacio insuficiente para grabar los formatos activos"));
    }
    Ok(())
}
async fn start(State(s): State<App>, h: HeaderMap, Query(q): Query<StartQuery>) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    activate(&s, true, q.record).await
}
async fn recording_start(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    activate(&s, false, true).await
}
/// Activa servicios: en la sesión en curso si la hay; si no, abre una nueva.
async fn activate(s: &App, live: bool, record: bool) -> Reply {
    let active = s.data.lock().await.active().cloned();
    match active {
        Some(b) => attach_services(s, b, live, record).await,
        None => start_session(s, live, record).await,
    }
}
async fn attach_services(s: &App, b: Broadcast, live: bool, record: bool) -> Reply {
    let (add_live, add_record) = (live && !b.live, record && !b.recording);
    if !add_live && !add_record {
        return Ok(Json(json!({"id":b.id,"status":b.status})));
    }
    if !s.engine.independent_services() {
        return Err(bad(FIXED_SERVICES));
    }
    if b.status == "ending" {
        return Err(bad("La sesión está finalizando"));
    }
    let sessions: Vec<_> = b
        .outputs
        .iter()
        .filter(|(_, id)| !id.is_empty())
        .map(|(format, id)| (format.clone(), id.clone()))
        .collect();
    if sessions.is_empty() {
        return Err(bad("El inicio todavía se está reconciliando"));
    }
    if add_live {
        let groups = output_groups(&s.master, &*s.data.lock().await)?;
        if groups.is_empty() {
            return Err(bad(NO_DESTINATION));
        }
        // Los destinos no se pueden editar con la sesión activa: los formatos coinciden.
        for (format, urls) in &groups {
            let id = b
                .outputs
                .get(format.name())
                .filter(|id| !id.is_empty())
                .ok_or_else(|| bad("Finaliza la sesión para emitir en este formato"))?;
            s.engine.set_destinations(id, urls).await?;
        }
    }
    let mut recordings = Vec::new();
    if add_record {
        let (dir, directory) = {
            let d = s.data.lock().await;
            (s.recordings_dir(&d), d.recordings_dir.clone())
        };
        ensure_recording_space(s, &dir, sessions.len())?;
        for (_, session) in &sessions {
            let used = {
                let d = s.data.lock().await;
                d.recordings
                    .iter()
                    .filter(|r| &r.session == session)
                    .count()
            };
            // La primera conserva el nombre de la sesión; las siguientes se numeran.
            let rid = if used == 0 {
                session.clone()
            } else {
                format!("{session}-r{}", used + 1)
            };
            s.engine
                .start_recording(
                    session,
                    output::RecordingTarget {
                        id: &rid,
                        dir: &dir,
                    },
                )
                .await?;
            recordings.push(Recording {
                id: rid.clone(),
                session: session.clone(),
                directory: directory.clone(),
                filename: format!("{rid}.mp4"),
                created: now(),
                status: "recording".into(),
                bytes: 0,
                duration: 0.0,
            });
        }
    }
    let mut d = s.data.lock().await;
    if add_live && d.slates.start.show_on_go_live {
        show_slate(s, &mut d, SlateKind::Start)?;
    }
    d.recordings.extend(recordings);
    let current = d.broadcasts.iter_mut().find(|x| x.id == b.id).unwrap();
    current.live |= add_live;
    current.recording |= add_record;
    let reply = json!({"id":current.id,"status":current.status});
    s.persist(&mut d)?;
    Ok(Json(reply))
}
async fn start_session(s: &App, live: bool, record: bool) -> Reply {
    let (broadcast_id, render_token, groups, profiles, recordings_dir);
    {
        let mut d = s.data.lock().await;
        let enabled = output_groups(&s.master, &d)?;
        if live && enabled.is_empty() {
            return Err(bad(NO_DESTINATION));
        }
        // La sesión compone los formatos de los destinos activos para que el directo pueda
        // sumarse después. Sin destinos, una grabación usa el formato horizontal.
        groups = if enabled.is_empty() {
            vec![(OutputFormat::Landscape, Vec::new())]
        } else {
            enabled
        };
        recordings_dir = s.recordings_dir(&d);
        if record {
            ensure_recording_space(s, &recordings_dir, groups.len())?;
        }
        let directory = d.recordings_dir.clone();
        profiles = groups
            .iter()
            .map(|(format, _)| output_profile(&d, *format, s.video_bitrate, s.audio_bitrate))
            .collect::<Vec<_>>();
        broadcast_id = id();
        render_token = random();
        d.broadcasts.push(Broadcast {
            id: broadcast_id.clone(),
            egress_id: None,
            status: "starting".into(),
            created: now(),
            ended: None,
            error: None,
            renderer_hash: hash(&render_token),
            renderer_revision: None,
            outputs: groups
                .iter()
                .map(|(f, _)| (f.name().to_owned(), String::new()))
                .collect(),
            destination_statuses: Default::default(),
            renderer_revisions: Default::default(),
            live,
            recording: record,
        });
        if live && d.slates.start.show_on_go_live {
            show_slate(s, &mut d, SlateKind::Start)?;
        }
        for (format, _) in groups.iter().filter(|_| record) {
            let rid = format.session_id(&broadcast_id);
            d.recordings.push(Recording {
                id: rid.clone(),
                session: rid.clone(),
                directory: directory.clone(),
                filename: format!("{rid}.mp4"),
                created: now(),
                status: "recording".into(),
                bytes: 0,
                duration: 0.0,
            });
        }
        s.persist(&mut d)?;
    }
    for ((format, destinations), (video_bitrate, audio_bitrate)) in groups.iter().zip(profiles) {
        let session_id = format.session_id(&broadcast_id);
        // `session` identifica el compositor de Egress aunque no tenga archivo de salida.
        let template = format!(
            "{}?render_token={render_token}&format={}&session={session_id}",
            s.renderer_base,
            format.name()
        );
        let result = s
            .engine
            .start(output::StartParams {
                broadcast_id: &session_id,
                render_url: &template,
                destinations: if live { destinations.as_slice() } else { &[] },
                record: record.then_some(output::RecordingTarget {
                    id: session_id.as_str(),
                    dir: &recordings_dir,
                }),
                video_bitrate,
                audio_bitrate,
                format: *format,
            })
            .await;
        let mut d = s.data.lock().await;
        let b = d
            .broadcasts
            .iter_mut()
            .find(|b| b.id == broadcast_id)
            .unwrap();
        match result {
            Ok(info) if info["egress_id"].is_string() => {
                let eid = info["egress_id"].as_str().unwrap().to_owned();
                if b.egress_id.is_none() {
                    b.egress_id = Some(eid.clone());
                }
                b.outputs.insert(format.name().into(), eid);
            }
            _ => {
                b.status = "uncertain".into();
                b.error = Some("Inicio no confirmado; comprobando los compositores".into());
            }
        }
        s.persist(&mut d)?;
    }
    // Publish renderer paths only after both input sessions exist.
    if s.engine.is_local() {
        *s.desktop_renderer.lock().unwrap() = Some((
            broadcast_id.clone(),
            format!(
                "/render?render_token={render_token}&ingest=1&format={}",
                groups[0].0.name()
            ),
        ));
    }
    let d = s.data.lock().await;
    Ok(Json(
        json!({"id":broadcast_id,"status":d.active().map(|b|&b.status)}),
    ))
}
/// Termina la sesión completa: se cierra el encoder y con él todos los servicios.
async fn stop_inner(s: &App) -> Result<(), Error> {
    let active = { s.data.lock().await.active().cloned() };
    let Some(active) = active else {
        return Ok(());
    };
    let mut ids: Vec<_> = active
        .outputs
        .values()
        .filter(|v| !v.is_empty())
        .cloned()
        .collect();
    if ids.is_empty() {
        ids.extend(active.egress_id.clone());
    }
    if ids.is_empty() {
        return Err(bad("El inicio todavía se está reconciliando"));
    }
    // Attempt every composition even if one engine refuses the stop.
    let mut failure = None;
    for id in ids {
        if let Err(e) = s.engine.stop(&id).await {
            failure = Some(e);
        }
    }
    if let Some(e) = failure {
        return Err(Error::from(e));
    }
    let mut d = s.data.lock().await;
    if let Some(b) = d.broadcasts.iter_mut().find(|b| b.id == active.id) {
        b.status = "ending".into();
    }
    s.persist(&mut d)?;
    Ok(())
}
/// Detiene un servicio y conserva el otro; sin otro servicio activo termina la sesión.
async fn stop_live(s: &App, all: bool) -> Result<(), Error> {
    let Some(active) = s.data.lock().await.active().cloned() else {
        return Ok(());
    };
    if all || !active.recording {
        return stop_inner(s).await;
    }
    if !active.live {
        return Ok(());
    }
    if !s.engine.independent_services() {
        return Err(bad(FIXED_SERVICES));
    }
    for id in active.outputs.values().filter(|id| !id.is_empty()) {
        s.engine.set_destinations(id, &[]).await?;
    }
    let mut d = s.data.lock().await;
    let b = d.broadcasts.iter_mut().find(|b| b.id == active.id).unwrap();
    b.live = false;
    b.destination_statuses.clear();
    s.persist(&mut d)?;
    Ok(())
}
async fn stop_recording_service(s: &App) -> Result<(), Error> {
    let Some(active) = s.data.lock().await.active().cloned() else {
        return Ok(());
    };
    if !active.live {
        return stop_inner(s).await;
    }
    if !active.recording {
        return Ok(());
    }
    if !s.engine.independent_services() {
        return Err(bad(FIXED_SERVICES));
    }
    for id in active.outputs.values().filter(|id| !id.is_empty()) {
        s.engine.stop_recording(id).await?;
    }
    let mut d = s.data.lock().await;
    let b = d.broadcasts.iter_mut().find(|b| b.id == active.id).unwrap();
    b.recording = false;
    s.persist(&mut d)?;
    Ok(())
}
async fn stop(State(s): State<App>, h: HeaderMap, Query(q): Query<StopQuery>) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    stop_live(&s, q.all).await?;
    Ok(Json(json!({"ok":true})))
}
async fn recording_stop(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    stop_recording_service(&s).await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize, Default)]
struct RetryQuery {
    destination_id: Option<String>,
}
async fn retry(State(s): State<App>, h: HeaderMap, Query(q): Query<RetryQuery>) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let groups = {
        let d = s.data.lock().await;
        let b = d
            .active()
            .filter(|b| b.status != "ending" && b.live)
            .ok_or_else(|| bad("No hay emisión activa"))?;
        if q.destination_id
            .as_ref()
            .is_some_and(|id| !d.destinations.iter().any(|x| &x.id == id && x.enabled))
        {
            return Err(bad("Destino no encontrado o desactivado"));
        }
        let mut groups: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for x in d
            .destinations
            .iter()
            .filter(|x| x.enabled && q.destination_id.as_ref().is_none_or(|id| id == &x.id))
        {
            // Re-adding a healthy Egress output can create duplicates. Only retry failed/unknown ones.
            if b.destination_statuses
                .get(&x.id)
                .is_some_and(|s| s == "live")
            {
                continue;
            }
            let eid = b
                .outputs
                .get(x.format.name())
                .filter(|id| !id.is_empty())
                .cloned()
                .or_else(|| b.egress_id.clone())
                .ok_or_else(|| bad("El inicio todavía se está reconciliando"))?;
            groups
                .entry(eid)
                .or_default()
                .push(unseal(&s.master, &x.sealed)?);
        }
        groups
    };
    for (egress, urls) in groups {
        s.engine.add_stream_output(&egress, &urls).await?;
    }
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct RenderQuery {
    render_token: String,
    #[serde(default)]
    format: OutputFormat,
}
async fn render_state(State(s): State<App>, Query(q): Query<RenderQuery>) -> Reply {
    s.render_access(&q.render_token).await?;
    let d = s.data.lock().await;
    Ok(Json(
        json!({"program":d.program_for(q.format),"format":q.format,"assets":d.assets.values().collect::<Vec<_>>(),"server_time_ms":now_ms(),"slates":d.slates,"active_slate":d.active_slate,"names":d.participants.values().map(|p|(p.id.clone(),p.name.clone())).chain(std::iter::once(("host".into(),"Anfitrión".into()))).collect::<std::collections::BTreeMap<_,_>>()}),
    ))
}
#[derive(Deserialize)]
struct Ack {
    revision: u64,
    screen_missing: bool,
    #[serde(default)]
    format: OutputFormat,
}
/// Credenciales de LiveKit para el compositor local (el de Egress las recibe de Egress).
async fn render_session(State(s): State<App>, h: HeaderMap, Query(q): Query<RenderQuery>) -> Reply {
    s.render_access(&q.render_token).await?;
    Ok(Json(
        json!({"url":s.livekit_url(&h),"token":s.lk.recorder_token_for(q.format)}),
    ))
}
/// El shell de escritorio pregunta qué ventana de compositor debe abrir (None = ninguna).
async fn desktop_renderer(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let active = s.data.lock().await.active().map(|b| b.id.clone());
    let url = s
        .desktop_renderer
        .lock()
        .unwrap()
        .clone()
        .filter(|(id, _)| active.as_ref() == Some(id))
        .map(|(_, url)| url);
    let d = s.data.lock().await;
    let urls: Vec<_> = url.as_ref().map(|url| {
        let first = url::Url::parse(&format!("http://localhost{url}")).ok()
            .and_then(|u| u.query_pairs().find(|(k,_)| k == "format").map(|(_,v)| v.into_owned())).unwrap_or_else(|| "landscape".into());
        let mut urls = vec![json!({"url":url,"format":first})];
        if d.active().is_some_and(|b| b.outputs.len() > 1) {
            urls.push(json!({"url":url.replace("format=landscape","format=portrait"),"format":"portrait"}));
        }
        urls
    }).unwrap_or_default();
    Ok(Json(json!({"url":url,"renderers":urls})))
}
/// Uso de recursos y consejos de capacidad (solo administrador).
async fn resources(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let (participants, on_program, live) = {
        let d = s.data.lock().await;
        let connected = d
            .participants
            .values()
            .filter(|p| p.connected && p.status == "admitted")
            .count();
        (
            connected,
            d.program.identities.len(),
            d.active().is_some_and(|b| b.status == "live"),
        )
    };
    let encoder = s.engine.stats();
    let (sample, history) = s.monitor.snapshot();
    let Some(sample) = sample else {
        return Ok(Json(json!({"ready":false})));
    };
    let (admitted, cap) = {
        let d = s.data.lock().await;
        (
            d.participants
                .values()
                .filter(|p| p.status == "admitted")
                .count(),
            s.admitted_cap(&d),
        )
    };
    let advice = monitor::advise(
        &sample,
        &monitor::Load {
            participants,
            on_program,
            live,
            encoder: encoder.as_ref(),
        },
    );
    Ok(Json(json!({
        "ready":true,"sample":sample,"history":history,"encoder":encoder,
        "participants":participants,"on_program":on_program,"live":live,"advice":advice,
        "admitted":admitted,"max_guests":cap,
        "can_admit":monitor::admission(Some(&sample),admitted,cap,encoder.as_ref(),live).is_ok()
    })))
}
async fn render_ack(State(s): State<App>, h: HeaderMap, Json(body): Json<Ack>) -> Reply {
    let token = h
        .get(header::AUTHORIZATION)
        .and_then(|x| x.to_str().ok())
        .and_then(|x| x.strip_prefix("Bearer "))
        .ok_or_else(denied)?;
    s.render_access(token).await?;
    let mut d = s.data.lock().await;
    if body.revision == d.program_for(body.format).revision {
        if body.screen_missing {
            let p = d.program_for_mut(body.format);
            p.screen = None;
            p.layout = Layout::Grid;
            p.revision += 1;
        }
        if let Some(b) = d.broadcasts.iter_mut().rev().find(|b| b.running()) {
            b.renderer_revisions
                .insert(body.format.name().into(), body.revision);
            if body.format == OutputFormat::Landscape {
                b.renderer_revision = Some(body.revision);
            }
        }
        s.persist(&mut d)?;
    }
    Ok(Json(json!({"ok":true})))
}
async fn recordings(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let d = s.data.lock().await;
    let default = std::path::absolute(&s.recordings).unwrap_or_else(|_| s.recordings.clone());
    let items: Vec<_> = d
        .recordings
        .iter()
        .rev()
        .map(|r| {
            let mut item = json!(r);
            item["location"] = json!(r.path(&default).display().to_string());
            item
        })
        .collect();
    Ok(Json(json!(items)))
}
fn recordings_location(s: &App, d: &Data) -> Value {
    let absolute = |p: &std::path::Path| {
        std::path::absolute(p)
            .unwrap_or_else(|_| p.to_owned())
            .display()
            .to_string()
    };
    let current = s.recordings_dir(d);
    json!({
        "path": absolute(&current),
        "default_path": absolute(&s.recordings),
        "is_default": d.recordings_dir.is_none(),
        "editable": s.engine.independent_services(),
        "locked": d.active().is_some_and(|b| b.recording),
        "available": current.is_dir(),
        "free_bytes": fs2::available_space(&current).ok(),
    })
}
async fn recordings_location_get(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let d = s.data.lock().await;
    Ok(Json(recordings_location(&s, &d)))
}
#[derive(Deserialize)]
struct RecordingsLocationBody {
    /// Sin valor vuelve a la carpeta predeterminada.
    path: Option<String>,
}
async fn recordings_location_put(
    State(s): State<App>,
    h: HeaderMap,
    Json(body): Json<RecordingsLocationBody>,
) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    if !s.engine.independent_services() {
        return Err(bad("La carpeta la define el despliegue de este servidor"));
    }
    let mut d = s.data.lock().await;
    if d.active().is_some_and(|b| b.recording) {
        return Err(bad("Detén la grabación para cambiar la carpeta"));
    }
    let chosen = body
        .path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from);
    if let Some(dir) = &chosen {
        if !dir.is_absolute() {
            return Err(bad("Indica la ruta completa de la carpeta"));
        }
        prepare_recordings_dir(dir)?;
    }
    let default = std::path::absolute(&s.recordings).unwrap_or_else(|_| s.recordings.clone());
    d.recordings_dir = chosen
        .filter(|dir| *dir != default)
        .map(|dir| dir.display().to_string());
    s.persist(&mut d)?;
    s.monitor.watch_disk(s.recordings_dir(&d));
    Ok(Json(recordings_location(&s, &d)))
}
async fn recording_download(
    State(s): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    s.admin(&h)?;
    let (filename, path) = {
        let d = s.data.lock().await;
        let r = d
            .recordings
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| bad("Grabación inexistente"))?;
        if r.status != "complete" {
            return Err(bad("La grabación no está finalizada"));
        }
        (r.filename.clone(), r.path(&s.recordings))
    };
    let req = Request::builder()
        .uri("/")
        .body(axum::body::Body::empty())
        .unwrap();
    use tower::ServiceExt;
    let response = tower_http::services::ServeFile::new(path)
        .oneshot(req)
        .await
        .map_err(|e| Error::from(anyhow::anyhow!("{e}")))?;
    let mut response = response.into_response();
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{filename}\"")
            .parse()
            .unwrap(),
    );
    Ok(response)
}
async fn recording_delete(State(s): State<App>, h: HeaderMap, Path(id): Path<String>) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    let r = d
        .recordings
        .iter()
        .find(|r| r.id == id)
        .ok_or_else(|| bad("Grabación inexistente"))?;
    if r.status == "recording" && d.active().is_some_and(|b| r.belongs_to(&b.id)) {
        return Err(bad("Grabación todavía activa"));
    }
    match tokio::fs::remove_file(r.path(&s.recordings)).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(Error::from(anyhow::Error::new(e))),
    }
    d.recordings.retain(|r| r.id != id);
    s.persist(&mut d)?;
    Ok(Json(json!({"ok":true})))
}
/// Entrada del compositor en modo escritorio: el renderer envía fragmentos WebM
/// (binarios) que se pasan al encoder ffmpeg. Se autentica con el token del renderer.
async fn ingest(
    State(s): State<App>,
    Query(q): Query<RenderQuery>,
    mut req: Request,
) -> Result<Response, Error> {
    use futures_util::StreamExt;
    use tokio_tungstenite::{
        WebSocketStream,
        tungstenite::{Message, handshake::derive_accept_key, protocol::Role},
    };
    s.render_access(&q.render_token).await?;
    let output::Engine::Ffmpeg(ffmpeg) = s.engine.clone() else {
        return Err(bad(
            "La ingesta solo existe en modo escritorio (ENGINE=ffmpeg)",
        ));
    };
    let id = s
        .data
        .lock()
        .await
        .active()
        .map(|b| q.format.session_id(&b.id))
        .ok_or_else(denied)?;
    let h = req.headers().clone();
    let key = h
        .get("sec-websocket-key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| bad("WebSocket key missing"))?;
    if h.get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map(str::to_ascii_lowercase)
        .as_deref()
        != Some("websocket")
        || h.get("sec-websocket-version").and_then(|v| v.to_str().ok()) != Some("13")
    {
        return Err(bad("Invalid WebSocket upgrade"));
    }
    let accept = derive_accept_key(key.as_bytes());
    let upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        let Ok(stream) = upgrade.await else { return };
        let mut ws = WebSocketStream::from_raw_socket(
            hyper_util::rt::TokioIo::new(stream),
            Role::Server,
            None,
        )
        .await;
        while let Some(Ok(message)) = ws.next().await {
            match message {
                Message::Binary(chunk) => {
                    if ffmpeg.feed(&id, &chunk).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });
    Ok(Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, "websocket")
        .header("sec-websocket-accept", accept)
        .body(axum::body::Body::empty())
        .unwrap())
}
async fn events(State(s): State<App>, mut req: Request) -> Result<Response, Error> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        WebSocketStream,
        tungstenite::{Message, handshake::derive_accept_key, protocol::Role},
    };
    let h = req.headers().clone();
    if !s.origin_allowed(&h) {
        return Err(denied());
    }
    s.participant(&h).await?;
    let key = h
        .get("sec-websocket-key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| bad("WebSocket key missing"))?;
    if h.get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map(str::to_ascii_lowercase)
        .as_deref()
        != Some("websocket")
        || h.get("sec-websocket-version").and_then(|v| v.to_str().ok()) != Some("13")
    {
        return Err(bad("Invalid WebSocket upgrade"));
    }
    let accept = derive_accept_key(key.as_bytes());
    let upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        let Ok(stream) = upgrade.await else { return };
        let mut ws = WebSocketStream::from_raw_socket(
            hyper_util::rt::TokioIo::new(stream),
            Role::Server,
            None,
        )
        .await;
        let mut rx = s.events.subscribe();
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(20));
        loop {
            tokio::select! {event=rx.recv()=>{if event.is_err()&&!matches!(event,Err(broadcast::error::RecvError::Lagged(_))){break}if s.participant(&h).await.is_err(){let _=ws.send(Message::Close(None)).await;break}if ws.send(Message::Text("refresh".into())).await.is_err(){break}},_=tick.tick()=>{if s.participant(&h).await.is_err(){break}if ws.send(Message::Ping(vec![].into())).await.is_err(){break}},message=ws.next()=>{if matches!(message,None|Some(Err(_))|Some(Ok(Message::Close(_)))){break}}}
        }
    });
    Ok((
        StatusCode::SWITCHING_PROTOCOLS,
        [
            (header::CONNECTION, "Upgrade".to_owned()),
            (header::UPGRADE, "websocket".to_owned()),
            (
                axum::http::HeaderName::from_static("sec-websocket-accept"),
                accept,
            ),
        ],
    )
        .into_response())
}
async fn webhook(State(s): State<App>, h: HeaderMap, body: Bytes) -> Reply {
    let token = h
        .get(header::AUTHORIZATION)
        .and_then(|x| x.to_str().ok())
        .ok_or_else(denied)?
        .trim_start_matches("Bearer ");
    let mut validation = jsonwebtoken::Validation::default();
    validation.set_issuer(&[&s.lk.key]);
    let claims = jsonwebtoken::decode::<Value>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(s.lk.secret.as_bytes()),
        &validation,
    )
    .map_err(|_| denied())?
    .claims;
    use sha2::Digest;
    let expected = base64::engine::general_purpose::STANDARD.encode(sha2::Sha256::digest(&body));
    if claims["sha256"].as_str() != Some(&expected) {
        return Err(denied());
    }
    let event: Value = serde_json::from_slice(&body).map_err(|_| bad("Evento inválido"))?;
    if event["room"]["name"] == ROOM
        && event["event"] == "track_unpublished"
        && (event["track"]["source"] == "SCREEN_SHARE" || event["track"]["source"] == 3)
    {
        let mut d = s.data.lock().await;
        for format in [OutputFormat::Landscape, OutputFormat::Portrait] {
            let p = d.program_for_mut(format);
            if p.screen.as_deref() == event["participant"]["identity"].as_str() {
                p.screen = None;
                p.layout = Layout::Grid;
                p.revision += 1;
            }
        }
        s.persist(&mut d)?;
    }
    // Egress and connection status are reconciled against the authoritative APIs, not event order.
    Ok(Json(json!({"ok":true})))
}
fn egress_status(value: &Value) -> &str {
    if value.is_null() {
        return "starting";
    }
    match value.as_str() {
        Some("EGRESS_STARTING") => "starting",
        Some("EGRESS_ACTIVE") => "live",
        Some("EGRESS_ENDING") => "ending",
        Some("EGRESS_COMPLETE") => "complete",
        Some("EGRESS_FAILED" | "EGRESS_ABORTED" | "EGRESS_LIMIT_REACHED") => "error",
        _ => match value.as_u64() {
            Some(0) => "starting",
            Some(1) => "live",
            Some(2) => "ending",
            Some(3) => "complete",
            _ => "error",
        },
    }
}
fn stream_state(status: &Value) -> &'static str {
    match status.as_str() {
        Some("ACTIVE") => "live",
        Some("FAILED" | "RECONNECTING") => "reconnecting",
        Some("FINISHED") => "finished",
        Some("CONNECTING") => "connecting",
        _ => match status.as_u64() {
            Some(0) => "live",
            Some(1) => "finished",
            Some(2) => "reconnecting",
            _ => "connecting",
        },
    }
}
fn latest_streams(info: &Value) -> std::collections::BTreeMap<String, Value> {
    let mut latest = std::collections::BTreeMap::new();
    for item in info["stream_results"].as_array().into_iter().flatten() {
        latest.insert(
            item["url"].as_str().unwrap_or("legacy").to_owned(),
            item.clone(),
        );
    }
    latest
}
fn apply_egress(d: &mut Data, active: &Broadcast, info: &Value, recordings: &std::path::Path) {
    let mut status = egress_status(&info["status"]).to_owned();
    if status == "live" {
        // Results include old attempts. Keep the latest attempt for EACH URL, not just the last platform.
        let latest = latest_streams(info);
        if latest
            .values()
            .any(|x| matches!(stream_state(&x["status"]), "reconnecting" | "finished"))
        {
            status = "reconnecting".into();
        } else if latest
            .values()
            .any(|x| stream_state(&x["status"]) == "connecting")
        {
            status = "starting".into();
        }
    }
    let b = d.broadcasts.iter_mut().find(|b| b.id == active.id).unwrap();
    b.egress_id = info["egress_id"].as_str().map(str::to_owned);
    b.status = status.clone();
    b.error = if status == "error" {
        Some("El compositor finalizó con error; revisa sus registros".into())
    } else if status == "reconnecting" {
        Some(if b.recording {
            "Hay salidas sin señal; las demás salidas y la grabación continúan. Revisa los destinos.".into()
        } else {
            "Hay salidas sin señal; las demás salidas continúan. Revisa los destinos.".into()
        })
    } else {
        None
    };
    if matches!(status.as_str(), "complete" | "error") {
        b.ended = Some(now());
        d.active_slate = None;
    }
    for r in d.recordings.iter_mut().filter(|r| r.belongs_to(&active.id)) {
        let recording = info["recording_results"]
            .as_array()
            .and_then(|results| results.iter().find(|f| f["id"] == r.id));
        let record_status = recording
            .and_then(|r| r["status"].as_str())
            .unwrap_or(&status);
        if r.status == "recording" && (record_status == "complete" || record_status == "error") {
            r.status = if record_status == "complete" {
                "complete"
            } else {
                "interrupted"
            }
            .into();
        }
        if let Ok(meta) = std::fs::metadata(r.path(recordings)) {
            r.bytes = meta.len();
        } else if record_status == "complete" {
            r.status = "missing".into();
        }
        if let Some(f) =
            recording.or_else(|| info["file_results"].as_array().and_then(|x| x.first()))
        {
            r.duration = f["duration"]
                .as_str()
                .and_then(|x| x.parse::<f64>().ok())
                .or_else(|| f["duration"].as_f64())
                .unwrap_or(0.0)
                / 1e9;
        }
    }
}
async fn reconcile(s: &App) -> anyhow::Result<()> {
    let _guard = s.operations.lock().await;
    // Respaldo del temporizador: la tarea programada se pierde si el servidor se reinicia.
    let expired = s
        .data
        .lock()
        .await
        .active_slate
        .clone()
        .filter(|a| a.ends_at_ms.is_some_and(|end| end <= now_ms()));
    if let Some(expired) = expired
        && let Err(e) = finish_slate_timer(s, &expired).await
    {
        tracing::warn!("no se pudo aplicar el fin del temporizador: {}", e.1);
    }
    let active = {
        let d = s.data.lock().await;
        d.active().cloned()
    };
    if let Some(active) = active {
        let jobs: Vec<_> = if active.outputs.is_empty() {
            vec![(
                "landscape".to_owned(),
                active.egress_id.clone().unwrap_or_default(),
            )]
        } else {
            active
                .outputs
                .iter()
                .map(|(f, id)| (f.clone(), id.clone()))
                .collect()
        };
        let mut infos = Vec::new();
        for (format, eid) in jobs {
            let f = if format == "portrait" {
                OutputFormat::Portrait
            } else {
                OutputFormat::Landscape
            };
            let rid = f.session_id(&active.id);
            let info = s
                .engine
                .find((!eid.is_empty()).then_some(eid.as_str()), &rid)
                .await?;
            infos.push((format, rid, info));
        }
        let expired = now().saturating_sub(active.created) > 90;
        let found = infos.iter().any(|(_, _, i)| i.is_some());
        let info = found.then(|| {
            let mut streams = Vec::new();
            let mut recordings = Vec::new();
            let mut states = Vec::new();
            for (_, rid, info) in &infos {
                let state = info.as_ref().map(|i| egress_status(&i["status"])).unwrap_or(if expired { "error" } else { "starting" });
                states.push(state);
                if let Some(info) = info { streams.extend(info["stream_results"].as_array().cloned().unwrap_or_default()); }
                // El motor local informa de cada grabación; Egress tiene como mucho una por compositor.
                if let Some(results) = info.as_ref().and_then(|i| i["recording_results"].as_array()) {
                    recordings.extend(results.iter().cloned());
                } else if active.recording {
                    let duration = info.as_ref().and_then(|i| i["file_results"].as_array()).and_then(|x| x.first()).map(|f| f["duration"].clone()).unwrap_or(Value::Null);
                    recordings.push(json!({"id":rid,"status":state,"duration":duration}));
                }
            }
            let terminal = states.iter().all(|s| matches!(*s,"complete"|"error"));
            let status = if terminal { if states.contains(&"error") { "EGRESS_FAILED" } else { "EGRESS_COMPLETE" } }
                else if active.status == "ending" { "EGRESS_ENDING" }
                else if states.contains(&"starting") { "EGRESS_STARTING" }
                else { "EGRESS_ACTIVE" };
            // A failed composition must not silently disappear while the other is still publishing.
            if !terminal && states.contains(&"error") { streams.push(json!({"url":"composition","status":"FAILED"})); }
            json!({"egress_id":active.egress_id,"status":status,"stream_results":streams,"recording_results":recordings})
        });
        let mut d = s.data.lock().await;
        if let Some(mut info) = info {
            let latest = latest_streams(&info);
            let destination_statuses: std::collections::BTreeMap<_, _> = d
                .destinations
                .iter()
                .filter(|x| x.enabled && active.live)
                .map(|x| {
                    let state = unseal(&s.master, &x.sealed)
                        .ok()
                        .and_then(|url| latest.get(&url).map(|x| stream_state(&x["status"])))
                        .unwrap_or("connecting");
                    (x.id.clone(), state.to_owned())
                })
                .collect();
            let b = d.broadcasts.iter_mut().find(|b| b.id == active.id).unwrap();
            b.destination_statuses = destination_statuses;
            for (format, _, i) in &infos {
                if let Some(id) = i.as_ref().and_then(|i| i["egress_id"].as_str()) {
                    b.outputs.insert(format.clone(), id.to_owned());
                    if b.egress_id.is_none() {
                        b.egress_id = Some(id.to_owned());
                    }
                }
            }
            info["egress_id"] = json!(b.egress_id);
            apply_egress(&mut d, &active, &info, &s.recordings);
            s.persist(&mut d)?;
        } else if now().saturating_sub(active.created) > 90 {
            let b = d.broadcasts.iter_mut().find(|b| b.id == active.id).unwrap();
            b.status = "error".into();
            b.ended = Some(now());
            b.error = Some("No se encontró un compositor activo".into());
            d.active_slate = None;
            for r in d
                .recordings
                .iter_mut()
                .filter(|r| r.status == "recording" && r.belongs_to(&active.id))
            {
                r.status = "interrupted".into();
            }
            s.persist(&mut d)?;
        }
        drop(d);
        if !s.engine.is_local() && now().saturating_sub(active.created) >= 7200 {
            let _ = stop_inner(s).await;
        } else if active.recording
            && fs2::available_space(s.recordings_dir(&*s.data.lock().await))
                .is_ok_and(|free| free < 1_000_000_000)
        {
            // Sin disco solo se detiene la grabación: el directo no escribe archivos.
            if s.engine.independent_services() {
                let _ = stop_recording_service(s).await;
            } else {
                let _ = stop_inner(s).await;
            }
        }
    }
    let response =
        s.lk.rpc("RoomService", "ListParticipants", json!({"room":ROOM}))
            .await;
    if let Ok(response) = response {
        let mut d = s.data.lock().await;
        let mut changed = false;
        for p in d.participants.values_mut() {
            let connected = response["participants"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|x| x["identity"] == p.id);
            if connected != p.connected {
                p.connected = connected;
                changed = true;
            }
        }
        for format in [OutputFormat::Landscape, OutputFormat::Portrait] {
            if let Some(screen) = d.program_for(format).screen.clone() {
                let exists = response["participants"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|p| p["identity"] == screen)
                    .is_some_and(|p| {
                        p["tracks"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|t| t["source"] == "SCREEN_SHARE" || t["source"] == 3)
                    });
                if !exists {
                    let p = d.program_for_mut(format);
                    p.screen = None;
                    p.layout = Layout::Grid;
                    p.revision += 1;
                    changed = true;
                }
            }
        }
        // Server-side revocation also removes clients that reconnected with an old, short-lived JWT.
        let unauthorized: Vec<String> = response["participants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| {
                let identity = p["identity"].as_str()?;
                let kind = p["kind"].as_str().unwrap_or("");
                if identity == "host"
                    || kind == "EGRESS"
                    || p["kind"] == 2
                    || identity.starts_with("EG_")
                {
                    return None;
                }
                if !d
                    .participants
                    .get(identity)
                    .is_some_and(|x| x.status == "admitted")
                {
                    Some(identity.into())
                } else {
                    None
                }
            })
            .collect();
        if changed {
            s.persist(&mut d)?;
        }
        drop(d);
        for identity in unauthorized {
            let _ = s.lk.remove(&identity).await;
        }
    }
    Ok(())
}
fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.into())
}
/// Modo escritorio: el backend sirve también el frontend compilado (sin Caddy).
/// Las rutas desconocidas de /api devuelven 404 en vez de caer al index.html.
fn with_static(router: Router, dir: &std::path::Path) -> Router {
    use tower_http::services::{ServeDir, ServeFile};
    router
        .route(
            "/api/{*rest}",
            axum::routing::any(|| async { StatusCode::NOT_FOUND }),
        )
        .fallback_service(ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html"))))
}
fn router(s: App) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route(
            "/api/v1/openapi.json",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    include_str!("../../docs/openapi.json"),
                )
            }),
        )
        .route("/api/v1/login", post(login))
        .route("/api/v1/logout", post(logout))
        .route("/lk/{*rest}", get(livekit_proxy))
        .route("/ca.pem", get(ca_pem))
        .route("/api/v1/desktop/enter", get(desktop_enter))
        .route(
            "/api/v1/remote-server",
            get(remote::view)
                .put(remote::configure)
                .delete(remote::disconnect),
        )
        .route("/api/v1/remote-server/check", post(remote::check))
        .route(
            "/api/v1/remote-session",
            post(remote::create).delete(remote::close),
        )
        .route(
            "/api/v1/remote-session/invitations",
            post(remote::invitation),
        )
        .route(
            "/api/v1/remote-session/invitations/{id}",
            delete(remote::revoke),
        )
        .route(
            "/api/v1/remote-session/participants/{id}",
            post(remote::decide),
        )
        .route("/api/v1/me", get(me))
        .route("/api/v1/studio", get(studio))
        .route("/api/v1/status", get(status))
        .route("/api/v1/events", get(events))
        .route("/api/v1/invitations", post(invite).get(invitations))
        .route("/api/v1/invitations/{id}", delete(revoke))
        .route("/api/v1/join", post(join))
        .route("/api/v1/token", post(token))
        .route("/api/v1/participants/{id}", post(participant_action))
        .route("/api/v1/program", put(program))
        .route("/api/v1/assets", get(assets::list).post(assets::upload))
        .route(
            "/api/v1/assets/{id}",
            get(assets::file).delete(assets::remove),
        )
        .route("/api/v1/destination", put(destination))
        .route(
            "/api/v1/destinations",
            get(destinations_list).post(destination_add),
        )
        .route(
            "/api/v1/destinations/{id}",
            axum::routing::patch(destination_update).delete(destination_remove),
        )
        .route("/api/v1/broadcast/start", post(start))
        .route("/api/v1/broadcast/stop", post(stop))
        .route("/api/v1/broadcast/retry", post(retry))
        .route("/api/v1/scenes", post(scene_save))
        .route("/api/v1/scenes/{id}/activate", post(scene_activate))
        .route(
            "/api/v1/scenes/{id}",
            delete(scene_remove).put(scene_update),
        )
        .route("/api/v1/renderer/state", get(render_state))
        .route("/api/v1/renderer/ack", post(render_ack))
        .route("/api/v1/renderer/session", get(render_session))
        .route("/api/v1/resources", get(resources))
        .route("/api/v1/desktop/renderer", get(desktop_renderer))
        .route("/api/v1/ingest", get(ingest))
        .route(
            "/api/v1/settings/recordings",
            get(recordings_location_get).put(recordings_location_put),
        )
        .route("/api/v1/settings/limits", put(limits_update))
        .route("/api/v1/slates/hide", post(slate_hide))
        .route("/api/v1/slates/{kind}", put(slate_update))
        .route("/api/v1/slates/{kind}/show", post(slate_show))
        .route("/api/v1/recording/start", post(recording_start))
        .route("/api/v1/recording/stop", post(recording_stop))
        .route("/api/v1/recordings", get(recordings))
        .route(
            "/api/v1/recordings/{id}",
            get(recording_download).delete(recording_delete),
        )
        .route("/api/v1/webhook", post(webhook))
        .layer(DefaultBodyLimit::max(512_000))
        .layer(middleware::from_fn_with_state(s.clone(), csrf))
        .layer(middleware::from_fn(|req: Request, next: Next| async move {
            let mut response = next.run(req).await;
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
            response
        }))
        // HTTP/2 (HTTPS local) no envía `Host`, solo `:authority`: se normaliza para el resto del código.
        .layer(middleware::from_fn(
            |mut req: Request, next: Next| async move {
                if !req.headers().contains_key(header::HOST) {
                    let authority = req.uri().authority().map(|a| a.as_str().to_owned());
                    if let Some(v) = authority.and_then(|a| a.parse().ok()) {
                        req.headers_mut().insert(header::HOST, v);
                    }
                }
                next.run(req).await
            },
        ))
        .with_state(s)
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(env("RUST_LOG", "streamhive=info"))
        .init();
    let runtime = PathBuf::from(env("DATA_DIR", "runtime"));
    std::fs::create_dir_all(&runtime)?;
    let recordings = PathBuf::from(env("RECORDINGS_DIR", "runtime/recordings"));
    std::fs::create_dir_all(&recordings)?;
    let assets = runtime.join("assets");
    std::fs::create_dir_all(&assets)?;
    let store = store::Store::open(runtime.join("studio.sqlite").to_str().unwrap())?;
    let password = env("ADMIN_PASSWORD", "");
    let reset_admin = std::env::args().any(|arg| arg == "--reset-admin-password");
    let admin_hash = match if reset_admin {
        None
    } else {
        store.setting("admin_hash")?
    } {
        Some(h) => h,
        None => {
            anyhow::ensure!(
                password.len() >= 12,
                "ADMIN_PASSWORD must contain at least 12 characters for initial setup"
            );
            let h = Argon2::default()
                .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
                .map_err(|e| anyhow::anyhow!("{e}"))?
                .to_string();
            store.set("admin_hash", &h)?;
            h
        }
    };
    if reset_admin {
        tracing::info!("Administrator password reset");
        return Ok(());
    }
    let session_secret = env("SESSION_SECRET", "");
    anyhow::ensure!(
        session_secret.len() >= 32,
        "SESSION_SECRET must contain at least 32 characters"
    );
    let master = base64::engine::general_purpose::STANDARD.decode(env("MASTER_KEY", ""))?;
    anyhow::ensure!(
        master.len() == 32,
        "MASTER_KEY must be 32 bytes encoded as base64"
    );
    let lk = livekit::LiveKit {
        endpoint: env("LIVEKIT_INTERNAL_URL", "http://127.0.0.1:7880"),
        public_url: env("LIVEKIT_PUBLIC_URL", "ws://localhost:7880"),
        key: env("LIVEKIT_API_KEY", "devkey"),
        secret: env("LIVEKIT_API_SECRET", "secret"),
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()?,
    };
    let origin = env("PUBLIC_ORIGIN", "http://localhost:5173");
    let data = store.load()?;
    let mut data = data;
    // Al arrancar no hay ninguna sesión viva que siga mostrando una pantalla.
    data.active_slate = None;
    let watched_disk = data
        .recordings_dir
        .as_ref()
        .map_or_else(|| recordings.clone(), PathBuf::from);
    if data.migrate_legacy_destination(id()) {
        store.save(&data)?;
    }
    for x in &data.destinations {
        unseal(&master, &x.sealed)
            .map_err(|_| anyhow::anyhow!("MASTER_KEY cannot decrypt the saved destinations"))?;
    }
    // HTTPS local opcional (TLS_PORT + TLS_NAMES): cámara/micrófono de invitados en la red.
    let tls = match std::env::var("TLS_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
    {
        Some(port) => {
            let names: Vec<String> = env("TLS_NAMES", "localhost")
                .split(',')
                .map(|n| n.trim().to_owned())
                .filter(|n| !n.is_empty())
                .collect();
            Some((
                port,
                tls::load_or_create(&runtime.join("tls"), &names).await?,
            ))
        }
        None => None,
    };
    let (events, _) = broadcast::channel(64);
    let s = App {
        data: Arc::new(Mutex::new(data)),
        store: Arc::new(StdMutex::new(store)),
        events,
        operations: Arc::new(Mutex::new(())),
        monitor: monitor::Monitor::spawn(
            std::env::var("STREAMHIVE_APP_PID")
                .ok()
                .and_then(|p| p.parse().ok()),
            watched_disk,
        ),
        desktop_token_hash: Some(env("DESKTOP_AUTOLOGIN_TOKEN", ""))
            .filter(|t| t.len() >= 32)
            .map(|t| hash(&t)),
        ca_pem: tls.as_ref().map(|(_, t)| Arc::new(t.ca_pem.clone())),
        max_guests: env("MAX_GUESTS", "10").parse().unwrap_or(10),
        desktop_renderer: Default::default(),
        remote: Default::default(),
        engine: match env("ENGINE", "egress").as_str() {
            "ffmpeg" => output::Engine::Ffmpeg(output::Ffmpeg::new(env("FFMPEG_BIN", "ffmpeg"))),
            "egress" => output::Engine::Egress(lk.clone()),
            other => anyhow::bail!("ENGINE desconocido: {other} (usa egress o ffmpeg)"),
        },
        lk,
        extra_origins: env("EXTRA_ORIGINS", "")
            .split(',')
            .map(|x| x.trim().trim_end_matches('/').to_owned())
            .filter(|x| x.starts_with("http://") || x.starts_with("https://"))
            .collect(),
        invite_origin: env("INVITE_ORIGIN", &origin)
            .trim_end_matches('/')
            .to_owned(),
        origin: origin.clone(),
        renderer_base: env("RENDERER_URL", "http://localhost:5173/render"),
        session_secret,
        master,
        admin_hash,
        video_bitrate: env("VIDEO_BITRATE_KBPS", "6000")
            .parse::<u32>()?
            .clamp(1000, 12000),
        audio_bitrate: env("AUDIO_BITRATE_KBPS", "160")
            .parse::<u32>()?
            .clamp(64, 320),
        recordings,
        assets,
        secure_cookie: origin.starts_with("https://"),
        login_attempts: Arc::new(Mutex::new((now(), 0))),
    };
    remote::start(s.clone());
    let worker = s.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            tick.tick().await;
            if let Err(e) = reconcile(&worker).await {
                tracing::warn!(error=%e,"reconciliation unavailable");
            }
        }
    });
    let listener = tokio::net::TcpListener::bind(env("LISTEN_ADDR", "0.0.0.0:8080")).await?;
    tracing::info!(address=%listener.local_addr()?,"StreamHive listening");
    let mut app = router(s);
    if let Ok(dir) = std::env::var("STATIC_DIR") {
        app = with_static(app, std::path::Path::new(&dir));
    }
    if let Some((port, tls)) = tls {
        let addr: std::net::SocketAddr = ([0, 0, 0, 0], port).into();
        tracing::info!(%addr, "StreamHive HTTPS listening");
        let https = app.clone();
        tokio::spawn(async move {
            if let Err(e) = axum_server::bind_rustls(addr, tls.config)
                .serve(https.into_make_service())
                .await
            {
                tracing::error!("HTTPS: {e}");
            }
        });
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rtmp_validation() {
        assert!(destination_url("https://example.org", "key").is_err());
        assert!(destination_url("rtmps://host/live", "key").is_ok());
        assert!(destination_url("rtmp://host/live", "\nkey").is_err());
    }
    #[test]
    fn states_accept_protobuf_names_and_numbers() {
        assert_eq!(egress_status(&json!(1)), "live");
        assert_eq!(egress_status(&json!("EGRESS_COMPLETE")), "complete");
        assert_eq!(egress_status(&json!("EGRESS_FAILED")), "error");
    }
}

#[cfg(test)]
mod api_tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_lk() -> livekit::LiveKit {
        livekit::LiveKit {
            endpoint: "http://127.0.0.1:1".into(),
            public_url: "wss://rtc.example.test".into(),
            key: "test-key".into(),
            secret: "livekit-test-secret".into(),
            client: reqwest::Client::new(),
        }
    }
    fn app() -> App {
        static PASSWORD: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        let password = PASSWORD
            .get_or_init(|| {
                Argon2::default()
                    .hash_password(b"correct-test-password", &SaltString::generate(&mut OsRng))
                    .unwrap()
                    .to_string()
            })
            .clone();
        App {
            data: Arc::new(Mutex::new(Data::default())),
            store: Arc::new(StdMutex::new(store::Store::open(":memory:").unwrap())),
            events: broadcast::channel(8).0,
            operations: Arc::new(Mutex::new(())),
            lk: test_lk(),
            engine: output::Engine::Egress(test_lk()),
            desktop_renderer: Default::default(),
            remote: Default::default(),
            monitor: Default::default(),
            max_guests: 5,
            ca_pem: None,
            desktop_token_hash: Some(hash("desktop-autologin-token-for-tests-0123456789")),
            origin: "https://studio.example.test".into(),
            extra_origins: vec!["https://lan.example.test".into()],
            invite_origin: "https://lan.example.test".into(),
            renderer_base: "http://web/render".into(),
            session_secret: "session-test-secret".into(),
            master: vec![9; 32],
            admin_hash: password,
            video_bitrate: 6000,
            audio_bitrate: 160,
            recordings: std::env::temp_dir(),
            assets: std::env::temp_dir(),
            secure_cookie: true,
            login_attempts: Arc::new(Mutex::new((now(), 0))),
        }
    }
    async fn call(
        s: &App,
        method: &str,
        path: &str,
        identity: Option<(&str, &str)>,
        body: Value,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::ORIGIN, &s.origin)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some((sub, role)) = identity {
            request = request.header(
                header::COOKIE,
                format!("sh_session={}", session(&s.session_secret, sub, role)),
            );
        }
        let response = router(s.clone())
            .oneshot(
                request
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            headers,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    async fn waiting(s: &App, identity: &str) {
        let mut d = s.data.lock().await;
        d.invitations.insert(
            "invite".into(),
            Invitation {
                id: "invite".into(),
                hash: hash("invitation-secret"),
                expires: now() + 3600,
                revoked: false,
            },
        );
        d.participants.insert(
            identity.into(),
            Participant {
                id: identity.into(),
                name: identity.into(),
                status: "waiting".into(),
                invite: "invite".into(),
                created: now(),
                connected: false,
            },
        );
    }
    #[tokio::test]
    async fn login_sets_secure_http_only_cookie_and_rejects_wrong_password() {
        let s = app();
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/v1/login",
                None,
                json!({"password":"wrong"})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        let (status, headers, _) = call(
            &s,
            "POST",
            "/api/v1/login",
            None,
            json!({"password":"correct-test-password"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let cookie = headers[header::SET_COOKIE].to_str().unwrap();
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("Secure"));
        assert!(cookie.contains("SameSite=Strict"));
    }
    #[tokio::test]
    async fn requests_without_origin_are_rejected_before_authentication() {
        let s = app();
        let response = router(s)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"password":"correct-test-password"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    #[tokio::test]
    async fn waiting_guests_cannot_get_media_tokens_or_change_program() {
        let s = app();
        waiting(&s, "guest").await;
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/v1/token",
                Some(("guest", "guest")),
                Value::Null
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &s,
                "PUT",
                "/api/v1/program",
                Some(("guest", "guest")),
                json!(Program::default())
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &s,
                "GET",
                "/api/v1/recordings",
                Some(("guest", "guest")),
                Value::Null
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn revoked_invitation_cannot_join_or_be_admitted() {
        let s = app();
        waiting(&s, "guest").await;
        s.data
            .lock()
            .await
            .invitations
            .get_mut("invite")
            .unwrap()
            .revoked = true;
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/v1/join",
                None,
                json!({"token":"invitation-secret","name":"Guest"})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/v1/participants/guest",
                Some(("host", "admin")),
                json!({"action":"admit"})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    #[tokio::test]
    async fn overloaded_hardware_blocks_admission_and_idle_hardware_allows_more_than_five() {
        let admit = |s: &App, id: String| {
            let s = s.clone();
            async move {
                call(
                    &s,
                    "POST",
                    &format!("/api/v1/participants/{id}"),
                    Some(("host", "admin")),
                    json!({"action":"admit"}),
                )
                .await
            }
        };
        let idle = monitor::Sample {
            cpu: 5.0,
            cpus: 16,
            mem_total: 32_000_000_000,
            mem_used: 4_000_000_000,
            disk_free: 200_000_000_000,
            ..Default::default()
        };
        let mut s = app();
        s.max_guests = 8;
        s.monitor = monitor::Monitor::with_sample(idle.clone());
        for n in 0..8 {
            waiting(&s, &format!("g{n}")).await;
            assert_eq!(
                admit(&s, format!("g{n}")).await.0,
                StatusCode::OK,
                "g{n} debía admitirse con hardware libre"
            );
        }
        waiting(&s, "extra").await;
        let (code, _, body) = admit(&s, "extra".into()).await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("Máximo de 8"));
        // Con el equipo sobrecargado no se admite a nadie, aunque no se haya llegado al tope.
        let mut s = app();
        s.monitor = monitor::Monitor::with_sample(monitor::Sample { cpu: 96.0, ..idle });
        waiting(&s, "late").await;
        let (code, _, body) = admit(&s, "late".into()).await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("sobrecargado"));
        assert_eq!(s.data.lock().await.participants["late"].status, "waiting");
    }
    #[tokio::test]
    async fn simultaneous_admissions_never_exceed_five_guests() {
        let s = app();
        for n in 0..6 {
            waiting(&s, &format!("g{n}")).await;
        }
        for n in 0..4 {
            assert_eq!(
                call(
                    &s,
                    "POST",
                    &format!("/api/v1/participants/g{n}"),
                    Some(("host", "admin")),
                    json!({"action":"admit"})
                )
                .await
                .0,
                StatusCode::OK
            );
        }
        let (a, b) = tokio::join!(
            call(
                &s,
                "POST",
                "/api/v1/participants/g4",
                Some(("host", "admin")),
                json!({"action":"admit"})
            ),
            call(
                &s,
                "POST",
                "/api/v1/participants/g5",
                Some(("host", "admin")),
                json!({"action":"admit"})
            )
        );
        assert_eq!(
            [a.0, b.0].iter().filter(|&&x| x == StatusCode::OK).count(),
            1
        );
        assert_eq!(
            s.data
                .lock()
                .await
                .participants
                .values()
                .filter(|p| p.status == "admitted")
                .count(),
            5
        );
    }
    #[test]
    fn legacy_single_destination_is_migrated_once_and_keeps_its_ciphertext() {
        let mut d = Data {
            destination: Some("cifrado-antiguo".into()),
            ..Default::default()
        };
        assert!(d.migrate_legacy_destination("nuevo".into()));
        assert!(d.destination.is_none());
        assert_eq!(
            (
                d.destinations.len(),
                d.destinations[0].sealed.as_str(),
                d.destinations[0].enabled
            ),
            (1, "cifrado-antiguo", true)
        );
        assert!(!d.migrate_legacy_destination("otro".into())); // idempotente
        // Un estudio guardado por una versión anterior (campo `destination`, sin `destinations`) se carga.
        let old: Data = serde_json::from_value(json!({"program":Data::default().program,"participants":{},"invitations":{},"broadcasts":[],"recordings":[],"destination":"x"})).unwrap();
        assert!(old.destinations.is_empty() && old.destination.is_some());
    }
    #[tokio::test]
    async fn several_platforms_can_be_added_toggled_removed_and_keys_never_leak() {
        let s = app();
        let admin = Some(("host", "admin"));
        let add = |body: Value| {
            let s = s.clone();
            async move {
                call(
                    &s,
                    "POST",
                    "/api/v1/destinations",
                    Some(("host", "admin")),
                    body,
                )
                .await
            }
        };
        let (c, _, yt) = add(json!({"platform":"youtube","key":"yt-secret-key"})).await;
        assert_eq!(c, StatusCode::OK);
        assert_eq!(yt["name"], "YouTube");
        assert_eq!(
            add(json!({"platform":"twitch","key":"tw-secret-key","name":"Mi Twitch"}))
                .await
                .0,
            StatusCode::OK
        );
        let (c, _, custom) = add(json!({"platform":"custom","name":"Kick","url":"rtmps://ingest.example.test/app","key":"kick-secret-key"})).await;
        assert_eq!(c, StatusCode::OK);
        // Validaciones.
        assert_eq!(
            add(json!({"platform":"tiktok-inventado","key":"k"}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            add(json!({"platform":"custom","key":"k"})).await.0,
            StatusCode::BAD_REQUEST
        ); // sin URL
        assert_eq!(
            add(json!({"platform":"custom","url":"https://no-es-rtmp.test","key":"k"}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            add(json!({"platform":"youtube","key":"  "})).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            add(json!({"platform":"youtube","key":"k","name":""}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        // Listado: hosts visibles, claves jamás (ni en el listado ni en el estudio).
        let (_, _, list) = call(&s, "GET", "/api/v1/destinations", admin, Value::Null).await;
        let text = list.to_string();
        assert_eq!(list["destinations"].as_array().unwrap().len(), 3);
        assert!(
            text.contains("a.rtmps.youtube.com")
                && text.contains("live.twitch.tv")
                && text.contains("ingest.example.test")
        );
        let (_, _, studio) = call(&s, "GET", "/api/v1/studio", admin, Value::Null).await;
        for secret in ["yt-secret-key", "tw-secret-key", "kick-secret-key"] {
            assert!(
                !text.contains(secret) && !studio.to_string().contains(secret),
                "{secret} no debe salir del servidor"
            );
            assert!(
                !format!("{:?}", s.data.lock().await.destinations).contains(secret),
                "{secret} debe estar cifrado en reposo"
            );
        }
        assert_eq!(studio["destination_configured"], true);
        // Las URL que se emitirán son las de los destinos activos, con su clave.
        let urls = enabled_destinations(&s.master, &*s.data.lock().await).unwrap();
        assert_eq!(urls.len(), 3);
        assert!(urls[0].ends_with("/live2/yt-secret-key"));
        // Desactivar uno / renombrar / sin sesión de administrador.
        let id_tw = list["destinations"][1]["id"].as_str().unwrap().to_owned();
        let patch = |body: Value| {
            let (s, id_tw) = (s.clone(), id_tw.clone());
            async move {
                call(
                    &s,
                    "PATCH",
                    &format!("/api/v1/destinations/{id_tw}"),
                    Some(("host", "admin")),
                    body,
                )
                .await
            }
        };
        assert_eq!(
            patch(json!({"enabled":false,"name":"Twitch off"})).await.0,
            StatusCode::OK
        );
        assert_eq!(
            enabled_destinations(&s.master, &*s.data.lock().await)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            call(&s, "GET", "/api/v1/destinations", None, Value::Null)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &s,
                "PATCH",
                "/api/v1/destinations/no-existe",
                admin,
                json!({"enabled":true})
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        // Borrar el personalizado.
        let idc = custom["id"].as_str().unwrap();
        assert_eq!(
            call(
                &s,
                "DELETE",
                &format!("/api/v1/destinations/{idc}"),
                admin,
                Value::Null
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(s.data.lock().await.destinations.len(), 2);
        // Tope de cinco y nada de cambios en directo.
        for n in 0..3 {
            assert_eq!(
                add(json!({"platform":"youtube","key":format!("k{n}")}))
                    .await
                    .0,
                StatusCode::OK
            );
        }
        assert_eq!(
            add(json!({"platform":"youtube","key":"sexto"})).await.0,
            StatusCode::BAD_REQUEST
        );
        s.data.lock().await.broadcasts.push(Broadcast {
            id: "live".into(),
            egress_id: None,
            status: "live".into(),
            created: now(),
            ended: None,
            error: None,
            renderer_hash: hash("x"),
            renderer_revision: None,
            outputs: Default::default(),
            destination_statuses: Default::default(),
            renderer_revisions: Default::default(),
            live: true,
            recording: true,
        });
        assert_eq!(
            patch(json!({"enabled":true})).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(
                &s,
                "DELETE",
                &format!("/api/v1/destinations/{id_tw}"),
                admin,
                Value::Null
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    #[tokio::test]
    async fn starting_requires_at_least_one_enabled_destination() {
        let s = app();
        let (c, _, b) = call(
            &s,
            "POST",
            "/api/v1/broadcast/start",
            Some(("host", "admin")),
            Value::Null,
        )
        .await;
        assert_eq!(c, StatusCode::BAD_REQUEST);
        assert!(b["error"].as_str().unwrap().contains("al menos un destino"));
        call(
            &s,
            "POST",
            "/api/v1/destinations",
            Some(("host", "admin")),
            json!({"platform":"youtube","key":"k"}),
        )
        .await;
        let id0 = s.data.lock().await.destinations[0].id.clone();
        call(
            &s,
            "PATCH",
            &format!("/api/v1/destinations/{id0}"),
            Some(("host", "admin")),
            json!({"enabled":false}),
        )
        .await;
        let (c, ..) = call(
            &s,
            "POST",
            "/api/v1/broadcast/start",
            Some(("host", "admin")),
            Value::Null,
        )
        .await;
        assert_eq!(c, StatusCode::BAD_REQUEST); // el único destino está desactivado
        assert!(
            s.data.lock().await.broadcasts.is_empty(),
            "no debe crearse una emisión sin destino"
        );
    }
    #[tokio::test]
    async fn destination_is_encrypted_and_never_returned_by_studio() {
        let s = app();
        assert_eq!(
            call(
                &s,
                "PUT",
                "/api/v1/destination",
                Some(("host", "admin")),
                json!({"url":"rtmps://example.test/live","key":"private-stream-key"})
            )
            .await
            .0,
            StatusCode::OK
        );
        let encrypted = s.data.lock().await.destinations[0].sealed.clone();
        assert!(!encrypted.contains("private-stream-key"));
        assert!(
            unseal(&s.master, &encrypted)
                .unwrap()
                .ends_with("private-stream-key")
        );
        let (_, _, snapshot) = call(
            &s,
            "GET",
            "/api/v1/studio",
            Some(("host", "admin")),
            Value::Null,
        )
        .await;
        assert!(!snapshot.to_string().contains(&encrypted));
        let saved = s.store.lock().unwrap().load().unwrap();
        assert_eq!(saved.destinations[0].sealed, encrypted);
    }
    #[tokio::test]
    async fn local_renderer_gets_hidden_subscribe_only_credentials() {
        let s = app();
        s.data.lock().await.broadcasts.push(Broadcast {
            id: "b1".into(),
            egress_id: None,
            status: "live".into(),
            created: now(),
            ended: None,
            error: None,
            renderer_hash: hash("renderer-secret"),
            renderer_revision: None,
            outputs: Default::default(),
            destination_statuses: Default::default(),
            renderer_revisions: Default::default(),
            live: true,
            recording: true,
        });
        let bad = call(
            &s,
            "GET",
            "/api/v1/renderer/session?render_token=wrong",
            None,
            Value::Null,
        )
        .await;
        assert_eq!(bad.0, StatusCode::UNAUTHORIZED);
        let (code, _, body) = call(
            &s,
            "GET",
            "/api/v1/renderer/session?render_token=renderer-secret",
            None,
            Value::Null,
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        let payload = body["token"].as_str().unwrap().split('.').nth(1).unwrap();
        let claims: Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(claims["sub"], "EG_recorder");
        assert_eq!(claims["video"]["hidden"], true);
        assert_eq!(claims["video"]["canPublish"], false);
        assert_eq!(body["url"], "wss://rtc.example.test");
        // Sin sesión de admin no se revela la URL del compositor.
        let (code, ..) = call(&s, "GET", "/api/v1/desktop/renderer", None, Value::Null).await;
        assert_eq!(code, StatusCode::UNAUTHORIZED);
        *s.desktop_renderer.lock().unwrap() =
            Some(("b1".into(), "/render?render_token=x&ingest=1".into()));
        let (_, _, body) = call(
            &s,
            "GET",
            "/api/v1/desktop/renderer",
            Some(("host", "admin")),
            Value::Null,
        )
        .await;
        assert_eq!(body["url"], "/render?render_token=x&ingest=1");
    }
    #[tokio::test]
    async fn lan_origin_is_accepted_but_unknown_origins_and_invite_base_follow_config() {
        let s = app();
        let req = |origin: &str| {
            let mut h = HeaderMap::new();
            h.insert(header::ORIGIN, origin.parse().unwrap());
            h
        };
        assert!(s.origin_allowed(&req("https://studio.example.test")));
        assert!(s.origin_allowed(&req("https://lan.example.test")));
        assert!(!s.origin_allowed(&req("https://evil.example.test")));
        assert!(!s.origin_allowed(&HeaderMap::new()));
        let (code, _, body) = call(
            &s,
            "POST",
            "/api/v1/invitations",
            Some(("host", "admin")),
            Value::Null,
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert!(
            body["url"]
                .as_str()
                .unwrap()
                .starts_with("https://lan.example.test/join/")
        );
    }
    #[tokio::test]
    async fn resources_endpoint_is_admin_only_and_reports_machine_and_advice() {
        let mut s = app();
        s.monitor = monitor::Monitor::spawn(None, std::env::temp_dir());
        let (code, ..) = call(&s, "GET", "/api/v1/resources", None, Value::Null).await;
        assert_eq!(code, StatusCode::UNAUTHORIZED);
        let mut body = Value::Null;
        for _ in 0..30 {
            body = call(
                &s,
                "GET",
                "/api/v1/resources",
                Some(("host", "admin")),
                Value::Null,
            )
            .await
            .2;
            if body["ready"] == true {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(body["ready"], true);
        assert!(body["sample"]["mem_total"].as_u64().unwrap() > 0);
        assert!(["ok", "warn", "critical"].contains(&body["advice"]["level"].as_str().unwrap()));
    }
    #[tokio::test]
    async fn desktop_token_grants_admin_session_only_when_valid_and_configured() {
        let s = app();
        let enter = |s: &App, t: &str| {
            let (s, t) = (s.clone(), t.to_owned());
            async move {
                let req = Request::builder()
                    .uri(format!("/api/v1/desktop/enter?token={t}"))
                    .body(Body::empty())
                    .unwrap();
                tower::ServiceExt::oneshot(router(s), req).await.unwrap()
            }
        };
        assert_eq!(
            enter(&s, "incorrecto").await.status(),
            StatusCode::UNAUTHORIZED
        );
        let ok = enter(&s, "desktop-autologin-token-for-tests-0123456789").await;
        assert_eq!(ok.status(), StatusCode::NO_CONTENT);
        let cookie = ok.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
        // La cookie recibida da acceso de administrador.
        let me = Request::builder()
            .uri("/api/v1/me")
            .header(header::COOKIE, cookie.split(';').next().unwrap())
            .body(Body::empty())
            .unwrap();
        let resp = tower::ServiceExt::oneshot(router(s.clone()), me)
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        // Sin token configurado (servidor/Docker/LAN) la ruta no existe a efectos prácticos.
        let mut off = app();
        off.desktop_token_hash = None;
        assert_eq!(
            enter(&off, "desktop-autologin-token-for-tests-0123456789")
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn http2_requests_without_host_header_still_get_the_right_livekit_url() {
        let mut s = app();
        s.lk.public_url = "auto".into();
        s.extra_origins = vec!["https://192.168.1.20:8443".into()];
        let req = Request::builder()
            .uri("https://192.168.1.20:8443/api/v1/me")
            .header(header::ORIGIN, &s.origin)
            .header(
                header::COOKIE,
                format!("sh_session={}", session(&s.session_secret, "host", "admin")),
            )
            .body(Body::empty())
            .unwrap();
        let resp = tower::ServiceExt::oneshot(router(s), req).await.unwrap();
        let body = http_body_util::BodyExt::collect(resp.into_body())
            .await
            .unwrap()
            .to_bytes();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["livekit_url"], "wss://192.168.1.20:8443/lk");
    }
    #[test]
    fn auto_livekit_url_follows_the_origin_the_client_used() {
        let mut s = app();
        s.lk.public_url = "auto".into();
        s.origin = "http://localhost:8780".into();
        s.extra_origins = vec![
            "https://192.168.1.20:8443".into(),
            "https://abc.trycloudflare.com".into(),
        ];
        let url = |host: &str| {
            let mut h = HeaderMap::new();
            h.insert(header::HOST, host.parse().unwrap());
            s.livekit_url(&h)
        };
        assert_eq!(url("localhost:8780"), "ws://localhost:8780/lk");
        assert_eq!(url("192.168.1.20:8443"), "wss://192.168.1.20:8443/lk");
        assert_eq!(
            url("abc.trycloudflare.com"),
            "wss://abc.trycloudflare.com/lk"
        );
        let mut fixed = app();
        fixed.lk.public_url = "wss://rtc.example.test".into();
        assert_eq!(
            fixed.livekit_url(&HeaderMap::new()),
            "wss://rtc.example.test"
        );
    }
    #[tokio::test]
    async fn livekit_proxy_only_exposes_signaling_paths() {
        let s = app();
        for path in [
            "/lk/twirp/livekit.RoomService/ListRooms",
            "/lk/debug/pprof",
            "/lk/rtcx",
        ] {
            let (code, ..) = call(&s, "GET", path, None, Value::Null).await;
            assert_eq!(
                code,
                StatusCode::NOT_FOUND,
                "{path} no debe llegar a LiveKit"
            );
        }
        // Una ruta de señalización válida sí se intenta (LiveKit de prueba inaccesible -> 502).
        let (code, ..) = call(
            &s,
            "GET",
            "/lk/rtc/validate?access_token=x",
            None,
            Value::Null,
        )
        .await;
        assert_eq!(code, StatusCode::BAD_GATEWAY);
    }
    #[tokio::test]
    async fn static_dir_serves_spa_but_unknown_api_stays_404() {
        let dir = std::env::temp_dir().join(format!("sh-static-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<h1>spa</h1>").unwrap();
        let app = with_static(router(app()), &dir);
        let get = |path: &str| {
            let app = app.clone();
            let req = Request::builder().uri(path).body(Body::empty()).unwrap();
            async move { tower::ServiceExt::oneshot(app, req).await.unwrap() }
        };
        let spa = get("/join/token-123").await;
        assert_eq!(spa.status(), StatusCode::OK);
        let body = http_body_util::BodyExt::collect(spa.into_body())
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(&body[..], b"<h1>spa</h1>");
        assert_eq!(get("/api/v1/nope").await.status(), StatusCode::NOT_FOUND);
        assert_eq!(get("/healthz").await.status(), StatusCode::OK);
        std::fs::remove_dir_all(dir).ok();
    }
    #[tokio::test]
    async fn ingest_streams_webm_over_websocket_into_ffmpeg_recording() {
        use futures_util::SinkExt;
        use tokio_tungstenite::{connect_async, tungstenite::Message};
        let Some(sample) = output::test_webm_sample().await else {
            eprintln!("ffmpeg con libvpx/libopus no disponible; prueba omitida");
            return;
        };
        let dir = std::env::temp_dir().join(format!("sh-ingest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = app();
        s.engine = output::Engine::Ffmpeg(output::Ffmpeg::new("ffmpeg"));
        s.data.lock().await.broadcasts.push(Broadcast {
            id: "b1".into(),
            egress_id: None,
            status: "starting".into(),
            created: now(),
            ended: None,
            error: None,
            renderer_hash: hash("renderer-secret"),
            renderer_revision: None,
            outputs: Default::default(),
            destination_statuses: Default::default(),
            renderer_revisions: Default::default(),
            live: true,
            recording: true,
        });
        s.engine
            .start(output::StartParams {
                record: Some(output::RecordingTarget {
                    id: "b1",
                    dir: &dir,
                }),
                broadcast_id: "b1",
                render_url: "",
                destinations: &[],
                video_bitrate: 800,
                audio_bitrate: 64,
                format: OutputFormat::Landscape,
            })
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(std::future::IntoFuture::into_future(axum::serve(
            listener,
            router(s.clone()),
        )));
        assert!(
            connect_async(format!("ws://{addr}/api/v1/ingest?render_token=wrong"))
                .await
                .is_err()
        );
        let (mut ws, _) = connect_async(format!(
            "ws://{addr}/api/v1/ingest?render_token=renderer-secret"
        ))
        .await
        .unwrap();
        for chunk in sample.chunks(16 * 1024) {
            ws.send(Message::Binary(chunk.to_vec().into()))
                .await
                .unwrap();
        }
        ws.close(None).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        s.engine.stop("b1").await.unwrap();
        let mut status = Value::Null;
        for _ in 0..100 {
            status = s.engine.find(Some("b1"), "b1").await.unwrap().unwrap();
            if status["status"] == "EGRESS_COMPLETE" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(status["status"], "EGRESS_COMPLETE");
        assert!(std::fs::metadata(dir.join("b1.mp4")).unwrap().len() > 1000);
        std::fs::remove_dir_all(dir).ok();
    }
    #[tokio::test]
    async fn renderer_is_scoped_to_active_session_and_revision() {
        let s = app();
        {
            let mut d = s.data.lock().await;
            d.broadcasts.push(Broadcast {
                id: "broadcast".into(),
                egress_id: Some("EG_test".into()),
                status: "live".into(),
                created: now(),
                ended: None,
                error: None,
                renderer_hash: hash("renderer-secret"),
                renderer_revision: None,
                outputs: Default::default(),
                destination_statuses: Default::default(),
                renderer_revisions: Default::default(),
                live: true,
                recording: true,
            });
        }
        assert_eq!(
            call(
                &s,
                "GET",
                "/api/v1/renderer/state?render_token=wrong",
                None,
                Value::Null
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &s,
                "GET",
                "/api/v1/renderer/state?render_token=renderer-secret",
                None,
                Value::Null
            )
            .await
            .0,
            StatusCode::OK
        );
        let (_, _, snapshot) = call(
            &s,
            "GET",
            "/api/v1/studio",
            Some(("host", "admin")),
            Value::Null,
        )
        .await;
        assert!(snapshot["broadcast"].get("renderer_hash").is_none());
        s.data.lock().await.broadcasts[0].status = "complete".into();
        assert_eq!(
            call(
                &s,
                "GET",
                "/api/v1/renderer/state?render_token=renderer-secret",
                None,
                Value::Null
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn stale_program_update_returns_conflict() {
        let s = app();
        let p = json!(Program::default());
        assert_eq!(
            call(
                &s,
                "PUT",
                "/api/v1/program",
                Some(("host", "admin")),
                p.clone()
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(&s, "PUT", "/api/v1/program", Some(("host", "admin")), p)
                .await
                .0,
            StatusCode::CONFLICT
        );
    }
    #[tokio::test]
    async fn unverified_webhook_cannot_modify_program() {
        let s = app();
        {
            let mut d = s.data.lock().await;
            d.program.screen = Some("host".into());
            d.program.layout = Layout::Screen;
        }
        let body = json!({"event":"track_unpublished","room":{"name":ROOM},"participant":{"identity":"host"},"track":{"source":"SCREEN_SHARE"}});
        assert_eq!(
            call(&s, "POST", "/api/v1/webhook", None, body).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(s.data.lock().await.program.layout, Layout::Screen);
    }

    #[tokio::test]
    async fn repeated_start_during_pending_session_returns_same_broadcast() {
        let s = app();
        {
            let mut d = s.data.lock().await;
            d.broadcasts.push(Broadcast {
                id: "pending".into(),
                egress_id: None,
                status: "uncertain".into(),
                created: now(),
                ended: None,
                error: None,
                renderer_hash: hash("renderer"),
                renderer_revision: None,
                outputs: Default::default(),
                destination_statuses: Default::default(),
                renderer_revisions: Default::default(),
                live: true,
                recording: true,
            });
        }
        for _ in 0..2 {
            let (status, _, body) = call(
                &s,
                "POST",
                "/api/v1/broadcast/start",
                Some(("host", "admin")),
                Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body["id"], "pending");
        }
        assert_eq!(s.data.lock().await.broadcasts.len(), 1);
    }
    #[tokio::test]
    async fn signed_webhook_accepts_original_body_and_rejects_tampering() {
        use sha2::Digest;
        let s = app();
        {
            let mut d = s.data.lock().await;
            d.program.screen = Some("host".into());
            d.program.layout = Layout::Screen;
        }
        let body=serde_json::to_vec(&json!({"event":"track_unpublished","room":{"name":ROOM},"participant":{"identity":"host"},"track":{"source":"SCREEN_SHARE"}})).unwrap();
        let token=jsonwebtoken::encode(&jsonwebtoken::Header::default(),&json!({"iss":s.lk.key,"exp":now()+60,"sha256":base64::engine::general_purpose::STANDARD.encode(sha2::Sha256::digest(&body))}),&jsonwebtoken::EncodingKey::from_secret(s.lk.secret.as_bytes())).unwrap();
        for (bytes, expected) in [
            (b"{}".to_vec(), StatusCode::UNAUTHORIZED),
            (body, StatusCode::OK),
        ] {
            let response = router(s.clone())
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/v1/webhook")
                        .header(header::AUTHORIZATION, &token)
                        .header(header::CONTENT_TYPE, "application/webhook+json")
                        .body(Body::from(bytes))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
        assert_eq!(s.data.lock().await.program.layout, Layout::Grid);
    }
    #[tokio::test]
    async fn live_and_recording_are_independent_services() {
        let dir = std::env::temp_dir().join(format!("sh-services-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = app();
        s.recordings = dir.clone();
        s.engine = output::Engine::Ffmpeg(output::Ffmpeg::new("ffmpeg"));
        let admin = Some(("host", "admin"));
        let post = |path: &'static str| {
            let s = s.clone();
            async move { call(&s, "POST", path, admin, Value::Null).await }
        };
        // Grabar no necesita destinos; emitir sí.
        assert_eq!(post("/api/v1/recording/start").await.0, StatusCode::OK);
        {
            let d = s.data.lock().await;
            let b = d.active().unwrap();
            assert!(b.recording && !b.live);
            assert_eq!(d.recordings.len(), 1);
        }
        assert_eq!(
            post("/api/v1/broadcast/start").await.0,
            StatusCode::BAD_REQUEST
        );
        // Detener la grabación, único servicio activo, termina la sesión.
        assert_eq!(post("/api/v1/recording/stop").await.0, StatusCode::OK);
        assert_eq!(s.data.lock().await.active().unwrap().status, "ending");
        s.data.lock().await.broadcasts.clear();
        s.data.lock().await.recordings.clear();

        call(
            &s,
            "POST",
            "/api/v1/destinations",
            admin,
            json!({"platform":"custom","name":"Sink","url":"rtmp://127.0.0.1:1/live","key":"k"}),
        )
        .await;
        // Iniciar el directo no graba.
        assert_eq!(post("/api/v1/broadcast/start").await.0, StatusCode::OK);
        {
            let d = s.data.lock().await;
            let b = d.active().unwrap();
            assert!(b.live && !b.recording);
            assert!(d.recordings.is_empty());
        }
        // Grabar a mitad del directo, detenerlo y volver a grabar sin cortar la emisión.
        let bid = s.data.lock().await.active().unwrap().id.clone();
        assert_eq!(post("/api/v1/recording/start").await.0, StatusCode::OK);
        assert_eq!(post("/api/v1/recording/stop").await.0, StatusCode::OK);
        {
            let d = s.data.lock().await;
            let b = d.active().unwrap();
            assert!(b.live && !b.recording && b.status != "ending");
        }
        assert_eq!(post("/api/v1/recording/start").await.0, StatusCode::OK);
        {
            let d = s.data.lock().await;
            let ids: Vec<_> = d.recordings.iter().map(|r| r.id.clone()).collect();
            assert_eq!(ids, [bid.clone(), format!("{bid}-r2")]);
        }
        // Cortar el directo conserva la grabación y la misma sesión; se puede volver a emitir.
        assert_eq!(post("/api/v1/broadcast/stop").await.0, StatusCode::OK);
        {
            let d = s.data.lock().await;
            let b = d.active().unwrap();
            assert!(!b.live && b.recording && b.id == bid && b.status != "ending");
        }
        assert_eq!(post("/api/v1/broadcast/start").await.0, StatusCode::OK);
        assert!(s.data.lock().await.active().unwrap().live);
        // Con ambos activos, finalizar todo cierra la sesión.
        assert_eq!(
            post("/api/v1/broadcast/stop?all=true").await.0,
            StatusCode::OK
        );
        assert_eq!(s.data.lock().await.active().unwrap().status, "ending");
        std::fs::remove_dir_all(dir).ok();
    }
    #[tokio::test]
    async fn recordings_use_the_chosen_folder_and_older_ones_stay_where_they_are() {
        let base = std::env::temp_dir().join(format!("sh-location-{}", id()));
        let default = base.join("default");
        let chosen = base.join("nested/chosen");
        std::fs::create_dir_all(&default).unwrap();
        let mut s = app();
        s.recordings = default.clone();
        s.engine = output::Engine::Ffmpeg(output::Ffmpeg::new("ffmpeg"));
        let admin = Some(("host", "admin"));
        let settings = "/api/v1/settings/recordings";
        // La ubicación predeterminada se ve sin configurar nada.
        let (c, _, v) = call(&s, "GET", settings, admin, Value::Null).await;
        assert_eq!(c, StatusCode::OK);
        assert_eq!(v["path"], default.display().to_string());
        assert_eq!(v["default_path"], default.display().to_string());
        assert_eq!(v["is_default"], true);
        // Los invitados no pueden ver ni cambiar rutas del equipo.
        let guest = Some(("guest", "guest"));
        assert_ne!(
            call(&s, "GET", settings, guest, Value::Null).await.0,
            StatusCode::OK
        );
        let (c, ..) = call(&s, "PUT", settings, guest, json!({"path":"/tmp/x"})).await;
        assert_ne!(c, StatusCode::OK);
        assert!(s.data.lock().await.recordings_dir.is_none());
        // Una ruta relativa o sobre un archivo se rechaza sin cambiar nada.
        let (c, ..) = call(&s, "PUT", settings, admin, json!({"path":"videos"})).await;
        assert_eq!(c, StatusCode::BAD_REQUEST);
        let file = base.join("file");
        std::fs::write(&file, b"x").unwrap();
        let (c, ..) = call(&s, "PUT", settings, admin, json!({"path":file})).await;
        assert_eq!(c, StatusCode::BAD_REQUEST);
        assert!(s.data.lock().await.recordings_dir.is_none());
        // Una grabación previa sigue en la carpeta donde se creó.
        std::fs::write(default.join("old.mp4"), b"old").unwrap();
        s.data.lock().await.recordings.push(Recording {
            id: "old".into(),
            session: "old".into(),
            directory: None,
            filename: "old.mp4".into(),
            created: now(),
            status: "complete".into(),
            bytes: 3,
            duration: 1.0,
        });
        // La carpeta elegida se crea si falta y no quedan archivos de prueba.
        let (c, _, v) = call(&s, "PUT", settings, admin, json!({"path":chosen})).await;
        assert_eq!(c, StatusCode::OK, "{v}");
        assert_eq!(v["path"], chosen.display().to_string());
        assert_eq!(v["is_default"], false);
        assert_eq!(std::fs::read_dir(&chosen).unwrap().count(), 0);
        // La grabación nueva va a la carpeta elegida y la carpeta queda bloqueada.
        let (c, ..) = call(&s, "POST", "/api/v1/recording/start", admin, Value::Null).await;
        assert_eq!(c, StatusCode::OK);
        let (bid, stored) = {
            let d = s.data.lock().await;
            let r = d.recordings.last().unwrap();
            (d.active().unwrap().id.clone(), r.path(&s.recordings))
        };
        assert_eq!(stored, chosen.join(format!("{bid}.mp4")));
        let (c, ..) = call(&s, "PUT", settings, admin, json!({"path":default})).await;
        assert_eq!(c, StatusCode::BAD_REQUEST);
        let (_, _, list) = call(&s, "GET", "/api/v1/recordings", admin, Value::Null).await;
        assert_eq!(
            list[1]["location"],
            default.join("old.mp4").display().to_string()
        );
        assert_eq!(list[0]["location"], stored.display().to_string());
        let (c, ..) = call(&s, "POST", "/api/v1/recording/stop", admin, Value::Null).await;
        assert_eq!(c, StatusCode::OK);
        s.data.lock().await.broadcasts.clear();
        // Elegir la predeterminada equivale a restablecerla; borrar usa la ruta original.
        let (c, _, v) = call(&s, "PUT", settings, admin, json!({"path":default})).await;
        assert_eq!(c, StatusCode::OK);
        assert_eq!(v["is_default"], true);
        let (c, ..) = call(&s, "DELETE", "/api/v1/recordings/old", admin, Value::Null).await;
        assert_eq!(c, StatusCode::OK);
        assert!(!default.join("old.mp4").exists());
        // Una carpeta elegida que ya no sirve da error: nunca se graba en otra sin avisar.
        s.data.lock().await.recordings_dir = Some(file.join("sub").display().to_string());
        let (c, _, v) = call(&s, "POST", "/api/v1/recording/start", admin, Value::Null).await;
        assert_eq!(c, StatusCode::BAD_REQUEST, "{v}");
        assert!(v["error"].as_str().unwrap().contains("No se puede guardar"));
        assert!(s.data.lock().await.active().is_none());
        std::fs::remove_dir_all(base).ok();
    }
    #[tokio::test]
    async fn egress_refuses_to_change_services_during_a_session() {
        let s = app();
        s.data.lock().await.broadcasts.push(Broadcast {
            id: "b".into(),
            egress_id: Some("e".into()),
            status: "live".into(),
            created: now(),
            ended: None,
            error: None,
            renderer_hash: String::new(),
            renderer_revision: None,
            outputs: [("landscape".to_string(), "e".to_string())].into(),
            destination_statuses: Default::default(),
            renderer_revisions: Default::default(),
            live: true,
            recording: false,
        });
        let (status, _, body) = call(
            &s,
            "POST",
            "/api/v1/recording/start",
            Some(("host", "admin")),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("finaliza la sesión")
        );
    }
    #[tokio::test]
    async fn active_recording_cannot_be_deleted() {
        let s = app();
        {
            let mut d = s.data.lock().await;
            d.broadcasts.push(Broadcast {
                id: "active".into(),
                egress_id: Some("EG_test".into()),
                status: "live".into(),
                created: now(),
                ended: None,
                error: None,
                renderer_hash: hash("renderer"),
                renderer_revision: None,
                outputs: Default::default(),
                destination_statuses: Default::default(),
                renderer_revisions: Default::default(),
                live: true,
                recording: true,
            });
            d.recordings.push(Recording {
                id: "active".into(),
                session: String::new(),
                directory: None,
                filename: "active.mp4".into(),
                created: now(),
                status: "recording".into(),
                bytes: 0,
                duration: 0.0,
            });
            let mut portrait = d.recordings[0].clone();
            portrait.id = "active-portrait".into();
            portrait.filename = "active-portrait.mp4".into();
            d.recordings.push(portrait);
        }
        for rid in ["active", "active-portrait"] {
            assert_eq!(
                call(
                    &s,
                    "DELETE",
                    &format!("/api/v1/recordings/{rid}"),
                    Some(("host", "admin")),
                    Value::Null
                )
                .await
                .0,
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(s.data.lock().await.recordings.len(), 2);
    }

    #[tokio::test]
    async fn asset_upload_requires_admin_and_streams_authenticated_ranges() {
        let s = app();
        let data = b"\x89PNG\r\n\x1a\n12345678".to_vec();
        for authenticated in [false, true] {
            let mut req = Request::builder()
                .method("POST")
                .uri("/api/v1/assets")
                .header(header::ORIGIN, &s.origin)
                .header(header::CONTENT_TYPE, "image/png")
                .header(
                    "x-file-name",
                    base64::engine::general_purpose::STANDARD.encode("Manual técnico.png"),
                );
            if authenticated {
                req = req.header(
                    header::COOKIE,
                    format!("sh_session={}", session(&s.session_secret, "host", "admin")),
                );
            }
            let response = router(s.clone())
                .oneshot(req.body(Body::from(data.clone())).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                if authenticated {
                    StatusCode::OK
                } else {
                    StatusCode::UNAUTHORIZED
                }
            );
        }
        let asset = s.data.lock().await.assets.values().next().unwrap().clone();
        let path = format!("/api/v1/assets/{}", asset.id);
        assert_eq!(
            call(&s, "GET", &path, None, Value::Null).await.0,
            StatusCode::UNAUTHORIZED
        );
        let response = router(s.clone())
            .oneshot(
                Request::builder()
                    .uri(&path)
                    .header(
                        header::COOKIE,
                        format!("sh_session={}", session(&s.session_secret, "host", "admin")),
                    )
                    .header(header::RANGE, "bytes=0-7")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .as_ref(),
            b"\x89PNG\r\n\x1a\n"
        );
        let mut program = s.data.lock().await.program.clone();
        program.layout = Layout::Screen;
        program.media_asset = Some(asset.id.clone());
        assert_eq!(
            call(
                &s,
                "PUT",
                "/api/v1/program",
                Some(("host", "admin")),
                json!(program)
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(&s, "DELETE", &path, Some(("host", "admin")), Value::Null)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        {
            let mut d = s.data.lock().await;
            d.program.media_asset = None;
            d.program.layout = Layout::Grid;
            d.program.background_asset = Some(asset.id.clone());
            d.broadcasts.push(Broadcast {
                id: "background-broadcast".into(),
                egress_id: Some("EG_bg".into()),
                status: "live".into(),
                created: now(),
                ended: None,
                error: None,
                renderer_hash: hash("bg-renderer"),
                renderer_revision: None,
                outputs: Default::default(),
                destination_statuses: Default::default(),
                renderer_revisions: Default::default(),
                live: true,
                recording: true,
            });
        }
        assert_eq!(
            call(&s, "DELETE", &path, Some(("host", "admin")), Value::Null)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        let render_path = format!("{path}?render_token=bg-renderer");
        assert_eq!(
            call(&s, "GET", &render_path, None, Value::Null).await.0,
            StatusCode::OK
        );
        s.data.lock().await.program.background_asset = None;
        assert_eq!(
            call(&s, "GET", &render_path, None, Value::Null).await.0,
            StatusCode::UNAUTHORIZED
        );
        s.data.lock().await.broadcasts.clear();
        assert_eq!(
            call(&s, "DELETE", &path, Some(("host", "admin")), Value::Null)
                .await
                .0,
            StatusCode::OK
        );
        assert!(!s.assets.join(asset.filename).exists());
    }
    #[test]
    fn persisted_studio_from_before_media_library_loads_with_safe_defaults() {
        let mut value = json!(Data::default());
        value.as_object_mut().unwrap().remove("assets");
        let program = value["program"].as_object_mut().unwrap();
        for key in [
            "media_asset",
            "content_mode",
            "pip_position",
            "microphones_enabled",
            "background",
            "background_asset",
            "playback",
        ] {
            program.remove(key);
        }
        let old: Data = serde_json::from_value(value).unwrap();
        assert!(old.assets.is_empty());
        assert!(old.program.background_asset.is_none());
        assert!(old.program.microphones_enabled);
        assert!(!old.program.playback.playing);
        assert_eq!(old.program.content_mode, ContentMode::Side);
    }
    #[tokio::test]
    async fn credential_edits_are_atomic_encrypted_and_partition_destinations_by_format() {
        let s = app();
        let admin = Some(("host", "admin"));
        let (_, _, created) = call(
            &s,
            "POST",
            "/api/v1/destinations",
            admin,
            json!({"platform":"facebook","name":"Evento","key":"old-secret"}),
        )
        .await;
        let path = format!("/api/v1/destinations/{}", created["id"].as_str().unwrap());
        let before = s.data.lock().await.destinations[0].sealed.clone();
        assert_eq!(
            call(
                &s,
                "PATCH",
                &path,
                admin,
                json!({"url":"https://invalid","key":"new-secret","format":"portrait"})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(s.data.lock().await.destinations[0].sealed, before);
        assert_eq!(
            call(&s, "PATCH", &path, None, json!({"key":"new-secret"}))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &s,
                "PATCH",
                &path,
                admin,
                json!({"key":"new-secret","format":"portrait"})
            )
            .await
            .0,
            StatusCode::OK
        );
        let (_, _, list) = call(&s, "GET", "/api/v1/destinations", admin, Value::Null).await;
        assert_eq!(list["destinations"][0]["format"], "portrait");
        assert_eq!(list["profiles"][1]["audio_bitrate"], 128);
        assert!(!list.to_string().contains("secret"));
        let d = s.data.lock().await;
        let groups = output_groups(&s.master, &d).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].0, OutputFormat::Portrait);
        assert!(groups[0].1[0].ends_with("/new-secret"));
        assert!(!format!("{:?}", d.destinations).contains("new-secret"));
    }
    #[tokio::test]
    async fn limits_cap_the_room_and_the_screen_without_removing_anyone() {
        let s = app();
        let admin = Some(("host", "admin"));
        let path = "/api/v1/settings/limits";
        let (_, _, studio) = call(&s, "GET", "/api/v1/studio", admin, Value::Null).await;
        assert_eq!(studio["limits"]["on_screen"], 6);
        assert_eq!(studio["limits"]["admitted"], s.max_guests);
        assert_ne!(
            call(
                &s,
                "PUT",
                path,
                Some(("guest", "guest")),
                json!({"on_screen":2,"admitted":1})
            )
            .await
            .0,
            StatusCode::OK
        );
        for invalid in [
            json!({"on_screen":0,"admitted":1}),
            json!({"on_screen":7,"admitted":1}),
            json!({"on_screen":2,"admitted":s.max_guests + 1}),
        ] {
            assert_eq!(
                call(&s, "PUT", path, admin, invalid).await.0,
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            call(&s, "PUT", path, admin, json!({"on_screen":2,"admitted":1}))
                .await
                .0,
            StatusCode::OK
        );
        // Sala: admite hasta el cupo; quien espera sigue esperando.
        waiting(&s, "ana").await;
        waiting(&s, "beto").await;
        let admit = json!({"action":"admit"});
        assert_eq!(
            call(&s, "POST", "/api/v1/participants/ana", admin, admit.clone())
                .await
                .0,
            StatusCode::OK
        );
        let (c, _, body) = call(
            &s,
            "POST",
            "/api/v1/participants/beto",
            admin,
            admit.clone(),
        )
        .await;
        assert_eq!(c, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("Cupo de invitados")
        );
        assert_eq!(s.data.lock().await.participants["beto"].status, "waiting");
        // Pantalla: el cupo impide añadir, no modificar lo que ya está.
        call(&s, "PUT", path, admin, json!({"on_screen":2,"admitted":2})).await;
        assert_eq!(
            call(&s, "POST", "/api/v1/participants/beto", admin, admit)
                .await
                .0,
            StatusCode::OK
        );
        let mut program = s.data.lock().await.program.clone();
        program.identities = vec!["host".into(), "ana".into(), "beto".into()];
        let (c, _, body) = call(&s, "PUT", "/api/v1/program", admin, json!(program)).await;
        assert_eq!(c, StatusCode::CONFLICT, "{body}");
        assert!(body["error"].as_str().unwrap().contains("Cupo de cámaras"));
        program.identities = vec!["host".into(), "ana".into()];
        program.layout = Layout::Featured;
        assert_eq!(
            call(&s, "PUT", "/api/v1/program", admin, json!(program))
                .await
                .0,
            StatusCode::OK
        );
        let (_, _, scene) = call(
            &s,
            "POST",
            "/api/v1/scenes",
            admin,
            json!({"name":"Dos","format":"landscape"}),
        )
        .await;
        assert_eq!(scene["program"]["layout"], "featured");
        call(&s, "PUT", path, admin, json!({"on_screen":1,"admitted":2})).await;
        assert_eq!(s.data.lock().await.program.identities.len(), 2);
        let mut same = s.data.lock().await.program.clone();
        same.names = !same.names;
        assert_eq!(
            call(&s, "PUT", "/api/v1/program", admin, json!(same))
                .await
                .0,
            StatusCode::OK
        );
        let (c, _, body) = call(
            &s,
            "POST",
            &format!("/api/v1/scenes/{}/activate", scene["id"].as_str().unwrap()),
            admin,
            Value::Null,
        )
        .await;
        assert_eq!(c, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("cupo"));
        // Datos anteriores conservan el máximo.
        let mut old = json!(Data::default());
        old.as_object_mut().unwrap().remove("on_screen_limit");
        let old: Data = serde_json::from_value(old).unwrap();
        assert_eq!(old.on_screen_cap(), 6);
    }
    #[tokio::test]
    async fn slates_are_admin_only_validated_and_stay_out_of_scenes() {
        let s = app();
        let admin = Some(("host", "admin"));
        let guest = Some(("guest", "guest"));
        let (_, _, studio) = call(&s, "GET", "/api/v1/studio", admin, Value::Null).await;
        assert_eq!(studio["slates"]["start"]["timer_seconds"], 300);
        assert_eq!(studio["slates"]["start"]["show_on_go_live"], true);
        assert_eq!(studio["slates"]["end"]["timer_seconds"], 0);
        assert!(studio["active_slate"].is_null());
        let show = "/api/v1/slates/pause/show";
        assert_ne!(
            call(&s, "POST", show, guest, Value::Null).await.0,
            StatusCode::OK
        );
        assert_ne!(
            call(
                &s,
                "PUT",
                "/api/v1/slates/pause",
                guest,
                json!({"title":"x"})
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(
                &s,
                "PUT",
                "/api/v1/slates/otra",
                admin,
                json!({"title":"x"})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        for invalid in [
            json!({"title":""}),
            json!({"title":"x".repeat(61)}),
            json!({"title":"dos\nlíneas"}),
            json!({"title":"x","background":"red"}),
            json!({"title":"x","timer_seconds":21601}),
            json!({"title":"x","music_volume":2.0}),
            json!({"title":"x","background_asset":"none"}),
            json!({"title":"x","music_asset":"none"}),
            json!({"title":"x","accent":"verde"}),
            json!({"title":"x","style":"neon"}),
            json!({"title":"x","logo_asset":"none"}),
            json!({"title":"x","brand_line":"y".repeat(61)}),
        ] {
            let (c, ..) = call(&s, "PUT", "/api/v1/slates/pause", admin, invalid.clone()).await;
            assert!(c.is_client_error(), "{invalid}");
        }
        assert_eq!(s.data.lock().await.slates.pause.title, "Volvemos enseguida");
        let (c, _, saved) = call(
            &s,
            "PUT",
            "/api/v1/slates/pause",
            admin,
            json!({"title":"Un momento","background":"#112233","timer_seconds":60}),
        )
        .await;
        assert_eq!(c, StatusCode::OK);
        assert_eq!(saved["title"], "Un momento");
        // Mostrar una pantalla no toca el programa ni se guarda en las escenas.
        let revision = s.data.lock().await.program.revision;
        assert_eq!(
            call(&s, "POST", show, admin, Value::Null).await.0,
            StatusCode::OK
        );
        {
            let d = s.data.lock().await;
            let active = d.active_slate.as_ref().unwrap();
            assert_eq!(active.kind, SlateKind::Pause);
            assert_eq!(active.ends_at_ms, Some(active.started_at_ms + 60_000));
            assert_eq!(d.program.revision, revision);
        }
        let (_, _, scene) = call(
            &s,
            "POST",
            "/api/v1/scenes",
            admin,
            json!({"name":"Con pausa","format":"landscape"}),
        )
        .await;
        assert!(scene["program"].get("active_slate").is_none());
        assert_eq!(
            call(&s, "POST", "/api/v1/slates/hide", admin, Value::Null)
                .await
                .0,
            StatusCode::OK
        );
        assert!(s.data.lock().await.active_slate.is_none());
        // Datos anteriores a esta función cargan con los valores por defecto.
        let mut old = json!(Data::default());
        let fields = old.as_object_mut().unwrap();
        fields.remove("slates");
        fields.remove("active_slate");
        let old: Data = serde_json::from_value(old).unwrap();
        assert_eq!(old.slates.end.title, "Gracias por acompañarnos");
        // Pantallas guardadas antes del diseño de marca reciben el estilo por defecto.
        let older: Slate =
            serde_json::from_value(json!({"title":"Vieja","background":"#000000"})).unwrap();
        assert_eq!(older.style, SlateStyle::Colmena);
        assert_eq!(older.accent, "#b9ee79");
        assert_eq!(older.logo_position, LogoPosition::Top);
        assert!(old.active_slate.is_none());
    }
    #[tokio::test]
    async fn the_timer_only_acts_when_automatic_and_on_the_same_slate() {
        let s = app();
        let active = ActiveSlate {
            kind: SlateKind::Pause,
            started_at_ms: 1,
            ends_at_ms: Some(2),
        };
        s.data.lock().await.active_slate = Some(active.clone());
        // Manual por defecto: la pantalla se queda.
        finish_slate_timer(&s, &active).await.unwrap();
        assert!(s.data.lock().await.active_slate.is_some());
        s.data.lock().await.slates.pause.auto_on_timer_end = true;
        // Un temporizador antiguo no retira otra pantalla mostrada después.
        let later = ActiveSlate {
            started_at_ms: 99,
            ..active.clone()
        };
        s.data.lock().await.active_slate = Some(later);
        finish_slate_timer(&s, &active).await.unwrap();
        assert!(s.data.lock().await.active_slate.is_some());
        s.data.lock().await.active_slate = Some(active.clone());
        finish_slate_timer(&s, &active).await.unwrap();
        assert!(s.data.lock().await.active_slate.is_none());
    }
    #[tokio::test]
    async fn going_live_shows_the_start_slate_and_automatic_end_finishes_the_session() {
        let dir = std::env::temp_dir().join(format!("sh-slates-{}", id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = app();
        s.recordings = dir.clone();
        s.engine = output::Engine::Ffmpeg(output::Ffmpeg::new("ffmpeg"));
        let admin = Some(("host", "admin"));
        call(
            &s,
            "POST",
            "/api/v1/destinations",
            admin,
            json!({"platform":"custom","name":"Sink","url":"rtmp://127.0.0.1:1/live","key":"k"}),
        )
        .await;
        // Solo grabar no pone la pantalla de inicio.
        call(&s, "POST", "/api/v1/recording/start", admin, Value::Null).await;
        assert!(s.data.lock().await.active_slate.is_none());
        call(&s, "POST", "/api/v1/recording/stop", admin, Value::Null).await;
        s.data.lock().await.broadcasts.clear();
        call(&s, "POST", "/api/v1/broadcast/start", admin, Value::Null).await;
        assert_eq!(
            s.data.lock().await.active_slate.as_ref().unwrap().kind,
            SlateKind::Start
        );
        // Fin automático: cierra la sesión y la pantalla sigue hasta que termina.
        s.data.lock().await.slates.end.auto_on_timer_end = true;
        let end = ActiveSlate {
            kind: SlateKind::End,
            started_at_ms: 5,
            ends_at_ms: Some(6),
        };
        s.data.lock().await.active_slate = Some(end.clone());
        finish_slate_timer(&s, &end).await.unwrap();
        {
            let d = s.data.lock().await;
            assert_eq!(d.active().unwrap().status, "ending");
            assert!(d.active_slate.is_some());
        }
        std::fs::remove_dir_all(dir).ok();
    }
    #[tokio::test]
    async fn slate_assets_are_protected_and_readable_by_the_renderer() {
        let s = app();
        let admin = Some(("host", "admin"));
        {
            let mut d = s.data.lock().await;
            for (id, kind, mime) in [
                ("song", "audio", "audio/mpeg"),
                ("wall", "image", "image/png"),
            ] {
                d.assets.insert(
                    id.into(),
                    Asset {
                        id: id.into(),
                        name: id.into(),
                        filename: format!("{id}.bin"),
                        mime: mime.into(),
                        kind: kind.into(),
                        bytes: 1,
                        created: now(),
                    },
                );
            }
        }
        // Cada tipo de archivo solo sirve para lo suyo.
        let (c, ..) = call(
            &s,
            "PUT",
            "/api/v1/slates/start",
            admin,
            json!({"title":"x","music_asset":"wall"}),
        )
        .await;
        assert_eq!(c, StatusCode::BAD_REQUEST);
        let (c, ..) = call(
            &s,
            "PUT",
            "/api/v1/slates/start",
            admin,
            json!({"title":"x","background_asset":"song"}),
        )
        .await;
        assert_eq!(c, StatusCode::BAD_REQUEST);
        let mut program = s.data.lock().await.program.clone();
        program.layout = Layout::Screen;
        program.media_asset = Some("song".into());
        assert_eq!(
            call(&s, "PUT", "/api/v1/program", admin, json!(program))
                .await
                .0,
            StatusCode::CONFLICT
        );
        let (c, ..) = call(
            &s,
            "PUT",
            "/api/v1/slates/start",
            admin,
            json!({"title":"x","music_asset":"song","background_asset":"wall"}),
        )
        .await;
        assert_eq!(c, StatusCode::OK);
        let (c, ..) = call(
            &s,
            "PUT",
            "/api/v1/slates/pause",
            admin,
            json!({"title":"x","logo_asset":"song"}),
        )
        .await;
        assert_eq!(c, StatusCode::BAD_REQUEST);
        // No se pueden borrar mientras una pantalla los use.
        for id in ["song", "wall"] {
            let (c, _, body) = call(
                &s,
                "DELETE",
                &format!("/api/v1/assets/{id}"),
                admin,
                Value::Null,
            )
            .await;
            assert_eq!(c, StatusCode::BAD_REQUEST);
            assert!(body["error"].as_str().unwrap().contains("pantalla"));
        }
        // El compositor accede a ellos y a nada más.
        s.data.lock().await.broadcasts.push(Broadcast {
            id: "b".into(),
            egress_id: None,
            status: "live".into(),
            created: now(),
            ended: None,
            error: None,
            renderer_hash: hash("renderer-token"),
            renderer_revision: None,
            outputs: Default::default(),
            destination_statuses: Default::default(),
            renderer_revisions: Default::default(),
            live: true,
            recording: false,
        });
        s.data.lock().await.assets.insert(
            "other".into(),
            Asset {
                id: "other".into(),
                name: "other".into(),
                filename: "other.bin".into(),
                mime: "image/png".into(),
                kind: "image".into(),
                bytes: 1,
                created: now(),
            },
        );
        let path = |id: &str| format!("/api/v1/assets/{id}?render_token=renderer-token");
        assert_ne!(
            call(&s, "GET", &path("song"), None, Value::Null).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(&s, "GET", &path("other"), None, Value::Null).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn a_scene_can_be_replaced_with_the_current_program() {
        let s = app();
        let admin = Some(("host", "admin"));
        let (_, _, scene) = call(
            &s,
            "POST",
            "/api/v1/scenes",
            admin,
            json!({"name":"Entrevista","format":"landscape"}),
        )
        .await;
        let path = format!("/api/v1/scenes/{}", scene["id"].as_str().unwrap());
        let mut program = s.data.lock().await.program.clone();
        program.background = "#abcdef".into();
        let (c, ..) = call(&s, "PUT", "/api/v1/program", admin, json!(program)).await;
        assert_eq!(c, StatusCode::OK);
        assert_ne!(s.data.lock().await.scenes[0].program.background, "#abcdef");
        let guest = Some(("guest", "guest"));
        assert_ne!(
            call(&s, "PUT", &path, guest, Value::Null).await.0,
            StatusCode::OK
        );
        let (c, _, updated) = call(&s, "PUT", &path, admin, Value::Null).await;
        assert_eq!(c, StatusCode::OK);
        assert_eq!(updated["name"], "Entrevista");
        assert_eq!(updated["id"], scene["id"]);
        assert_eq!(s.data.lock().await.scenes[0].program.background, "#abcdef");
        let missing = call(&s, "PUT", "/api/v1/scenes/none", admin, Value::Null).await;
        assert_eq!(missing.0, StatusCode::BAD_REQUEST);
    }
    #[tokio::test]
    async fn scenes_keep_formats_and_revisions_independent_and_remove_revoked_guests() {
        let s = app();
        let admin = Some(("host", "admin"));
        let mut portrait = s.data.lock().await.portrait_program.clone();
        portrait.background = "#abcdef".into();
        portrait.identities = vec!["host".into()];
        assert_eq!(
            call(
                &s,
                "PUT",
                "/api/v1/program?format=portrait",
                admin,
                json!(portrait)
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(
                &s,
                "PUT",
                "/api/v1/program?format=portrait",
                admin,
                json!(portrait)
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let (_, _, scene) = call(
            &s,
            "POST",
            "/api/v1/scenes",
            admin,
            json!({"name":"Vertical","format":"portrait"}),
        )
        .await;
        let activate = format!("/api/v1/scenes/{}/activate", scene["id"].as_str().unwrap());
        let mut changed = s.data.lock().await.portrait_program.clone();
        changed.background = "#112233".into();
        assert_eq!(
            call(
                &s,
                "PUT",
                "/api/v1/program?format=portrait",
                admin,
                json!(changed)
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(&s, "POST", &activate, None, Value::Null).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(&s, "POST", &activate, admin, Value::Null).await.0,
            StatusCode::OK
        );
        let (_, _, studio) = call(&s, "GET", "/api/v1/studio", admin, Value::Null).await;
        assert_eq!(studio["program"]["revision"], 0);
        assert_eq!(studio["portrait_program"]["revision"], 3);
        assert_eq!(studio["portrait_program"]["background"], "#abcdef");
        let mut d = s.data.lock().await;
        d.remove_from_program("host");
        assert!(d.portrait_program.identities.is_empty());
        assert!(d.scenes[0].program.identities.is_empty());
    }
    #[test]
    fn backup_server_queries_and_stream_key_queries_are_combined_after_the_stream_name() {
        assert_eq!(
            destination_url("rtmps://host/live?backup=1", "stream?token=secret").unwrap(),
            "rtmps://host/live/stream?token=secret&backup=1"
        );
        assert!(destination_url("rtmps://user:pass@host/live", "key").is_err());
    }
    #[tokio::test]
    async fn remote_server_url_only_enrollment_is_encrypted_reused_and_admin_only() {
        let s = app();
        let admin = Some(("host", "admin"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://localhost:{}", listener.local_addr().unwrap().port());
        let db = std::env::temp_dir()
            .join(format!("sh-remote-test-{}", id()))
            .join("sessions.sqlite");
        let cloud = streamhive_sessions::App::open(
            streamhive_sessions::Config::new(&origin, db.clone()).unwrap(),
        )
        .unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, streamhive_sessions::router(cloud))
                .await
                .unwrap();
        });
        assert_eq!(
            call(
                &s,
                "PUT",
                "/api/v1/remote-server",
                None,
                json!({"url":origin})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/v1/remote-server/check",
                admin,
                json!({"url":origin})
            )
            .await
            .0,
            StatusCode::OK
        );
        let conn = rusqlite::Connection::open(&db).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM installations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        for _ in 0..2 {
            assert_eq!(
                call(
                    &s,
                    "PUT",
                    "/api/v1/remote-server",
                    admin,
                    json!({"url":origin})
                )
                .await
                .0,
                StatusCode::OK
            );
        }
        assert_eq!(
            conn.query_row("SELECT count(*) FROM installations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let stored = s
            .store
            .lock()
            .unwrap()
            .setting("remote_sessions_v1")
            .unwrap()
            .unwrap();
        let config: Value = serde_json::from_str(&stored).unwrap();
        let secret = unseal(&s.master, config["sealed_credential"].as_str().unwrap()).unwrap();
        assert!(!stored.contains(&secret));
        let (_, _, safe) = call(&s, "GET", "/api/v1/remote-server", admin, Value::Null).await;
        assert!(!safe.to_string().contains(&secret));
        assert!(!safe.to_string().contains("sealed_credential"));
        assert_eq!(
            call(
                &s,
                "PUT",
                "/api/v1/remote-server",
                admin,
                json!({"url":"http://example.com"})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            s.store
                .lock()
                .unwrap()
                .setting("remote_sessions_v1")
                .unwrap()
                .unwrap(),
            stored
        );
        remote::start(s.clone());
        for _ in 0..40 {
            if call(&s, "GET", "/api/v1/remote-server", admin, Value::Null)
                .await
                .2["status"]
                == "connected"
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(
            call(&s, "POST", "/api/v1/remote-session", admin, json!({}))
                .await
                .0,
            StatusCode::OK
        );
        let (_, _, invite) = call(
            &s,
            "POST",
            "/api/v1/remote-session/invitations",
            admin,
            json!({}),
        )
        .await;
        assert!(invite["url"].as_str().unwrap().starts_with(&origin));
        assert_eq!(
            call(&s, "DELETE", "/api/v1/remote-server", admin, Value::Null)
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            s.store
                .lock()
                .unwrap()
                .setting("remote_sessions_v1")
                .unwrap()
                .as_deref(),
            Some("")
        );
        task.abort();
    }
    #[tokio::test]
    async fn remote_server_rejects_untrusted_tls_certificates() {
        let s = app();
        let admin = Some(("host", "admin"));
        let dir = std::env::temp_dir().join(format!("sh-remote-tls-{}", id()));
        let tls = crate::tls::load_or_create(&dir, &["localhost".into()])
            .await
            .unwrap();
        let reserved = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = reserved.local_addr().unwrap();
        drop(reserved);
        let trusted_client = reqwest::Client::builder()
            .add_root_certificate(reqwest::Certificate::from_pem(tls.ca_pem.as_bytes()).unwrap())
            .timeout(std::time::Duration::from_secs(1))
            .build()
            .unwrap();
        let task = tokio::spawn(async move {
            axum_server::bind_rustls(addr, tls.config)
                .serve(
                    Router::new()
                        .route(
                            "/api/v1/meta",
                            get(|| async {
                                Json(json!({"service":"streamhive-sessions","protocol":1}))
                            }),
                        )
                        .into_make_service(),
                )
                .await
                .unwrap();
        });
        let meta_url = format!("https://localhost:{}/api/v1/meta", addr.port());
        let mut ready = false;
        for _ in 0..20 {
            if trusted_client
                .get(&meta_url)
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                ready = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert!(ready, "the TLS fixture must be reachable with its own CA");
        let (code, _, _) = call(
            &s,
            "POST",
            "/api/v1/remote-server/check",
            admin,
            json!({"url":format!("https://localhost:{}",addr.port())}),
        )
        .await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert!(
            s.store
                .lock()
                .unwrap()
                .setting("remote_sessions_v1")
                .unwrap()
                .is_none()
        );
        task.abort();
    }
    #[tokio::test]
    async fn incompatible_remote_protocol_never_replaces_saved_configuration() {
        let s = app();
        let admin = Some(("host", "admin"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://localhost:{}", listener.local_addr().unwrap().port());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/api/v1/meta",
                    get(|| async { Json(json!({"service":"streamhive-sessions","protocol":2})) }),
                ),
            )
            .await
            .unwrap();
        });
        assert_eq!(
            call(
                &s,
                "PUT",
                "/api/v1/remote-server",
                admin,
                json!({"url":origin})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert!(
            s.store
                .lock()
                .unwrap()
                .setting("remote_sessions_v1")
                .unwrap()
                .is_none()
        );
        task.abort();
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    fn data() -> (Data, Broadcast) {
        let b = Broadcast {
            id: "test".into(),
            egress_id: Some("EG_test".into()),
            status: "starting".into(),
            created: now(),
            ended: None,
            error: None,
            renderer_hash: hash("render"),
            renderer_revision: None,
            outputs: Default::default(),
            destination_statuses: Default::default(),
            renderer_revisions: Default::default(),
            live: true,
            recording: true,
        };
        let mut d = Data::default();
        d.broadcasts.push(b.clone());
        d.recordings.push(Recording {
            id: b.id.clone(),
            session: String::new(),
            directory: None,
            filename: format!("{}.mp4", id()),
            created: now(),
            status: "recording".into(),
            bytes: 0,
            duration: 0.0,
        });
        (d, b)
    }
    #[test]
    fn a_healthy_last_destination_cannot_hide_another_failed_platform() {
        let (mut d, b) = data();
        apply_egress(
            &mut d,
            &b,
            &json!({"egress_id":"EG_test","status":"EGRESS_ACTIVE","stream_results":[
            {"url":"a","status":"FAILED"},{"url":"b","status":"ACTIVE"}]}),
            &std::env::temp_dir(),
        );
        assert_eq!(d.broadcasts[0].status, "reconnecting");
        apply_egress(
            &mut d,
            &b,
            &json!({"egress_id":"EG_test","status":"EGRESS_ACTIVE","stream_results":[
            {"url":"a","status":"FAILED"},{"url":"b","status":"ACTIVE"},{"url":"a","status":"ACTIVE"}]}),
            &std::env::temp_dir(),
        );
        assert_eq!(d.broadcasts[0].status, "live");
    }
    #[test]
    fn new_stream_retry_can_recover_after_old_failed_result() {
        let (mut d, b) = data();
        apply_egress(
            &mut d,
            &b,
            &json!({"egress_id":"EG_test","status":"EGRESS_ACTIVE","stream_results":[{"status":"FAILED"}]}),
            &std::env::temp_dir(),
        );
        assert_eq!(d.broadcasts[0].status, "reconnecting");
        assert_eq!(d.recordings[0].status, "recording");
        apply_egress(
            &mut d,
            &b,
            &json!({"egress_id":"EG_test","status":"EGRESS_ACTIVE","stream_results":[{"status":"FAILED"},{"status":"ACTIVE"}]}),
            &std::env::temp_dir(),
        );
        assert_eq!(d.broadcasts[0].status, "live");
        assert!(d.broadcasts[0].error.is_none());
    }
    #[test]
    fn terminal_error_never_marks_an_incomplete_recording_as_complete() {
        let (mut d, b) = data();
        apply_egress(
            &mut d,
            &b,
            &json!({"egress_id":"EG_test","status":4}),
            &std::env::temp_dir(),
        );
        assert_eq!(d.recordings[0].status, "interrupted");
        assert!(d.active().is_none());
        assert!(d.broadcasts[0].ended.is_some());
    }
    #[test]
    fn completed_egress_with_missing_file_cannot_be_downloaded_as_complete() {
        let (mut d, b) = data();
        apply_egress(
            &mut d,
            &b,
            &json!({"egress_id":"EG_test","status":3,"file_results":[{"duration":"120000000000"}]}),
            &std::env::temp_dir(),
        );
        assert_eq!(d.recordings[0].status, "missing");
        assert_eq!(d.recordings[0].duration, 120.0);
    }
}
