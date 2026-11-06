//! Outbound-only control connection. Remote credentials never enter studio snapshots.
use crate::{App, Error, Reply, bad, denied, seal, unseal};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Mutex;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
const SETTING: &str = "remote_sessions_v1";
#[derive(Clone, Serialize, Deserialize)]
struct Saved {
    url: String,
    installation_id: String,
    sealed_credential: String,
    /// El servidor tiene LiveKit (`/api/v1/meta` → `media: true`).
    #[serde(default)]
    media: bool,
    /// Usar el servidor para cámara y audio cuando lo tiene (por defecto sí).
    #[serde(default = "yes")]
    use_media: bool,
}
fn yes() -> bool {
    true
}
pub struct Remote {
    changes: watch::Sender<u64>,
    state: Mutex<Value>,
    /// Permiso de administración de la sala en el servidor: (URL, token, sala, caducidad).
    pub media_admin: Mutex<Option<(String, String, String, u64)>>,
}
impl Default for Remote {
    fn default() -> Self {
        Self {
            changes: watch::channel(0).0,
            state: Mutex::new(json!({"url":null,"status":"unconfigured","snapshot":null})),
            media_admin: Mutex::new(None),
        }
    }
}
fn saved(s: &App) -> Result<Option<Saved>, Error> {
    s.store
        .lock()
        .unwrap()
        .setting(SETTING)?
        .filter(|s| !s.is_empty())
        .map(|v| serde_json::from_str(&v).map_err(|_| bad("Configuración del servidor inválida")))
        .transpose()
}
fn credential(s: &App, c: &Saved) -> Result<String, Error> {
    unseal(&s.master, &c.sealed_credential).map_err(Error::from)
}
/// Servidor cuyo LiveKit usa el estudio para cámara y audio, si está en uso.
pub fn media_target(s: &App) -> Option<(String, String)> {
    let c = saved(s).ok().flatten().filter(|c| c.media && c.use_media)?;
    let credential = credential(s, &c).ok()?;
    Some((c.url, credential))
}
fn save(s: &App, c: &Saved) -> Result<(), Error> {
    s.store.lock().unwrap().set(
        SETTING,
        &serde_json::to_string(c).map_err(|_| bad("No se pudo guardar"))?,
    )?;
    Ok(())
}
/// Recuerda si el servidor tiene medios; si cambia, la sala del estudio cambia de sitio.
fn remember_media(s: &App, meta: &Value) -> Result<(), Error> {
    let media = meta["media"] == true;
    if let Some(mut c) = saved(s)? {
        if c.media != media {
            c.media = media;
            save(s, &c)?;
        }
    }
    Ok(())
}
fn changed(s: &App) {
    s.remote.changes.send_modify(|n| *n += 1);
}
fn update(
    s: &App,
    url: Option<&str>,
    status: &str,
    snapshot: Option<Value>,
    message: Option<&str>,
) {
    *s.remote.state.lock().unwrap() =
        json!({"url":url,"status":status,"snapshot":snapshot,"error":message});
    let _ = s.events.send(());
}
pub fn normalize(raw: &str) -> Result<String, Error> {
    let u = url::Url::parse(raw.trim()).map_err(|_| bad("Introduce una URL válida"))?;
    let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
        || (u.scheme() != "https" && !(u.scheme() == "http" && local))
    {
        return Err(bad(
            "Usa la URL HTTPS del servidor, sin rutas ni credenciales. HTTP solo se permite en localhost.",
        ));
    }
    Ok(u.origin().ascii_serialization())
}
fn client() -> Result<reqwest::Client, Error> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| bad("No se pudo crear la conexión"))
}
async fn request(
    url: &str,
    token: Option<String>,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, Error> {
    let mut q = client()?.request(method, format!("{url}/api/v1{path}"));
    if let Some(token) = token {
        q = q.bearer_auth(token);
    }
    if let Some(body) = body {
        q = q.json(&body);
    }
    let mut r = q
        .send()
        .await
        .map_err(|_| bad("No se pudo conectar. Comprueba la URL, el certificado y la red."))?;
    if !r.status().is_success() {
        return Err(Error(
            StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            if r.status().as_u16() == 401 {
                "La instalación no está autorizada. Vuelve a guardar la URL para vincularla.".into()
            } else if r.status().as_u16() == 429 {
                "Espera unos segundos antes de enviar otro mensaje".into()
            } else {
                "El servidor no pudo completar la operación".into()
            },
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = r
        .chunk()
        .await
        .map_err(|_| bad("Respuesta incompleta del servidor"))?
    {
        let limit = if path.starts_with("/chat/") {
            2_000_000
        } else {
            512000
        };
        if bytes.len() + chunk.len() > limit {
            return Err(bad("Respuesta demasiado grande"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| bad("El servidor no devolvió una respuesta válida"))
}
async fn verify(url: &str) -> Result<Value, Error> {
    let m = request(url, None, reqwest::Method::GET, "/meta", None).await?;
    if m["service"] != "streamhive-sessions" {
        return Err(bad(
            "La URL no corresponde a un servidor de sesiones de StreamHive",
        ));
    }
    if m["protocol"] != 1 {
        return Err(Error(
            StatusCode::CONFLICT,
            "El protocolo del servidor es incompatible; actualiza la app o el servidor".into(),
        ));
    }
    Ok(m)
}
#[derive(Deserialize)]
pub struct UrlBody {
    url: String,
}
pub async fn check(State(s): State<App>, h: HeaderMap, Json(b): Json<UrlBody>) -> Reply {
    s.admin(&h)?;
    let url = normalize(&b.url)?;
    let meta = verify(&url).await?;
    Ok(Json(
        json!({"ok":true,"url":url,"version":meta["version"],"protocol":meta["protocol"]}),
    ))
}
pub async fn view(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let mut v = s.remote.state.lock().unwrap().clone();
    let c = saved(&s)?;
    v["media"] = json!(c.as_ref().is_some_and(|c| c.media));
    v["use_media"] = json!(c.as_ref().is_none_or(|c| c.use_media));
    v["media_active"] = json!(media_target(&s).is_some());
    Ok(Json(v))
}
#[derive(Deserialize)]
pub struct MediaBody {
    enabled: bool,
}
/// Cámara y audio por el servidor o por este equipo. No se cambia en pleno directo.
pub async fn set_media(State(s): State<App>, h: HeaderMap, Json(b): Json<MediaBody>) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    if s.data.lock().await.active().is_some() {
        return Err(bad(
            "Termina el directo o la grabación antes de cambiar dónde va la cámara y el audio",
        ));
    }
    let mut c = configured(&s).await?;
    c.use_media = b.enabled;
    save(&s, &c)?;
    *s.remote.media_admin.lock().unwrap() = None;
    sync_guests(&s).await;
    changed(&s);
    Ok(Json(
        json!({"ok":true,"media_active":media_target(&s).is_some()}),
    ))
}
pub async fn configure(State(s): State<App>, h: HeaderMap, Json(b): Json<UrlBody>) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let url = normalize(&b.url)?;
    let meta = verify(&url).await?;
    let previous = saved(&s)?;
    if previous.as_ref().is_none_or(|c| c.url != url) && s.data.lock().await.active().is_some() {
        return Err(bad(
            "Termina el directo o la grabación antes de cambiar de servidor",
        ));
    }
    if previous.as_ref().is_some_and(|c| c.url != url)
        && s.remote.state.lock().unwrap()["snapshot"]["session"].is_object()
    {
        return Err(bad(
            "Finaliza la sesión remota antes de cambiar de servidor",
        ));
    }
    let reuse = if let Some(c) = previous.filter(|c| c.url == url) {
        let result = request(
            &url,
            Some(credential(&s, &c)?),
            reqwest::Method::GET,
            "/sessions/current",
            None,
        )
        .await;
        match result {
            Ok(_) => Some(c),
            Err(e) if e.0 == StatusCode::UNAUTHORIZED => None,
            Err(e) => return Err(e),
        }
    } else {
        None
    };
    let c = if let Some(c) = reuse {
        c
    } else {
        let r = request(
            &url,
            None,
            reqwest::Method::POST,
            "/installations",
            Some(json!({})),
        )
        .await?;
        let id = r["installation_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| bad("Identificador de instalación inválido"))?;
        let key = r["credential"]
            .as_str()
            .filter(|s| s.len() >= 32 && s.len() <= 128)
            .ok_or_else(|| bad("Credencial de instalación inválida"))?;
        Saved {
            url: url.clone(),
            installation_id: id.into(),
            sealed_credential: seal(&s.master, key)?,
            media: false,
            use_media: true,
        }
    };
    let c = Saved {
        media: meta["media"] == true,
        ..c
    };
    save(&s, &c)?;
    *s.remote.media_admin.lock().unwrap() = None;
    update(&s, Some(&url), "connecting", None, None);
    changed(&s);
    Ok(Json(json!({"ok":true})))
}
pub async fn disconnect(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    if media_target(&s).is_some() && s.data.lock().await.active().is_some() {
        return Err(bad(
            "Termina el directo o la grabación antes de desconectar el servidor: la cámara y el audio van por él",
        ));
    }
    if let Some(c) = saved(&s)? {
        let sid = s.remote.state.lock().unwrap()["snapshot"]["session"]["id"]
            .as_str()
            .map(str::to_owned);
        if let Some(sid) = sid {
            let _ = request(
                &c.url,
                Some(credential(&s, &c)?),
                reqwest::Method::POST,
                &format!("/sessions/{sid}/close"),
                Some(json!({})),
            )
            .await;
        }
    }
    s.store.lock().unwrap().set(SETTING, "")?;
    *s.remote.media_admin.lock().unwrap() = None;
    update(&s, None, "unconfigured", None, None);
    sync_guests(&s).await;
    changed(&s);
    Ok(Json(json!({"ok":true})))
}
async fn configured(s: &App) -> Result<Saved, Error> {
    saved(s)?.ok_or_else(|| bad("Configura la URL del servidor de sesiones"))
}
pub async fn create(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let c = configured(&s).await?;
    let snapshot = request(
        &c.url,
        Some(credential(&s, &c)?),
        reqwest::Method::POST,
        "/sessions/current",
        Some(json!({})),
    )
    .await?;
    update(&s, Some(&c.url), "connecting", Some(snapshot.clone()), None);
    changed(&s);
    Ok(Json(snapshot))
}
fn current_id(s: &App) -> Result<String, Error> {
    s.remote.state.lock().unwrap()["snapshot"]["session"]["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| bad("Crea una sesión remota primero"))
}
pub async fn invitation(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let c = configured(&s).await?;
    let sid = current_id(&s)?;
    request(
        &c.url,
        Some(credential(&s, &c)?),
        reqwest::Method::POST,
        &format!("/sessions/{sid}/invitations"),
        Some(json!({})),
    )
    .await
    .map(Json)
}
pub async fn close(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let c = configured(&s).await?;
    let sid = current_id(&s)?;
    let r = request(
        &c.url,
        Some(credential(&s, &c)?),
        reqwest::Method::POST,
        &format!("/sessions/{sid}/close"),
        Some(json!({})),
    )
    .await?;
    update(&s, Some(&c.url), "connecting", None, None);
    sync_guests(&s).await;
    changed(&s);
    Ok(Json(r))
}
#[derive(Deserialize)]
pub struct Decision {
    action: String,
}
pub async fn decide(
    State(s): State<App>,
    h: HeaderMap,
    Path(pid): Path<String>,
    Json(b): Json<Decision>,
) -> Reply {
    s.admin(&h)?;
    if uuid::Uuid::parse_str(&pid).is_err()
        || !["admit", "reject", "remove"].contains(&b.action.as_str())
    {
        return Err(bad("Acción o participante inválido"));
    }
    let c = configured(&s).await?;
    let sid = current_id(&s)?;
    request(
        &c.url,
        Some(credential(&s, &c)?),
        reqwest::Method::POST,
        &format!("/sessions/{sid}/participants/{pid}"),
        Some(json!({"action":b.action})),
    )
    .await
    .map(Json)
}
pub async fn revoke(State(s): State<App>, h: HeaderMap, Path(iid): Path<String>) -> Reply {
    s.admin(&h)?;
    if uuid::Uuid::parse_str(&iid).is_err() {
        return Err(denied());
    }
    let c = configured(&s).await?;
    request(
        &c.url,
        Some(credential(&s, &c)?),
        reqwest::Method::DELETE,
        &format!("/invitations/{iid}"),
        None,
    )
    .await
    .map(Json)
}
/// Marca de los participantes del estudio que son invitados del servidor (`g-<id>`).
pub const REMOTE_INVITE: &str = "remote";
/// Invitados del servidor = participantes del estudio (`g-<id>`): quien espera aparece en la sala
/// de espera del estudio (con aviso), y los admitidos en Fuentes → Participantes cuando la cámara
/// y el audio van por el servidor (sin medios, los admitidos solo están en el chat).
pub async fn sync_guests(s: &App) {
    let media = media_target(s).is_some();
    let guests: Vec<(String, String, String)> = if saved(s).ok().flatten().is_some() {
        s.remote.state.lock().unwrap()["snapshot"]["participants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["status"] == "waiting" || (media && p["status"] == "admitted"))
            .filter_map(|p| {
                Some((
                    format!("g-{}", p["id"].as_str()?),
                    p["name"].as_str()?.to_owned(),
                    p["status"].as_str()?.to_owned(),
                ))
            })
            .collect()
    } else {
        Vec::new()
    };
    let mut d = s.data.lock().await;
    let mut changed = false;
    for (id, name, status) in &guests {
        match d.participants.get_mut(id) {
            Some(p) if p.status != *status => {
                p.status = status.clone();
                changed = true;
            }
            Some(_) => {}
            None => {
                d.participants.insert(
                    id.clone(),
                    crate::model::Participant {
                        id: id.clone(),
                        name: name.clone(),
                        status: status.clone(),
                        invite: REMOTE_INVITE.into(),
                        created: crate::now(),
                        connected: false,
                    },
                );
                changed = true;
            }
        }
    }
    let gone: Vec<String> = d
        .participants
        .values()
        .filter(|p| p.invite == REMOTE_INVITE && !guests.iter().any(|(id, ..)| id == &p.id))
        .map(|p| p.id.clone())
        .collect();
    for id in gone {
        d.participants.remove(&id);
        d.remove_from_program(&id);
        changed = true;
    }
    if changed {
        let _ = s.persist(&mut d);
    }
}
/// Decide en el servidor sobre un invitado remoto desde el estudio (`g-<id>`): admit, reject o remove.
pub async fn decide_guest(s: &App, identity: &str, action: &str) -> Result<(), Error> {
    let pid = identity.strip_prefix("g-").ok_or_else(denied)?;
    let c = configured(s).await?;
    let sid = current_id(s)?;
    request(
        &c.url,
        Some(credential(s, &c)?),
        reqwest::Method::POST,
        &format!("/sessions/{sid}/participants/{pid}"),
        Some(json!({"action":action})),
    )
    .await?;
    Ok(())
}
pub fn start(s: App) {
    tokio::spawn(async move {
        let mut changes = s.remote.changes.subscribe();
        loop {
            let c = saved(&s).ok().flatten();
            if let Some(c) = c {
                let mut delay = 1u64;
                loop {
                    let attempt = async {
                        let meta = verify(&c.url).await?;
                        remember_media(&s, &meta)?;
                        let snapshot = request(
                            &c.url,
                            Some(credential(&s, &c)?),
                            reqwest::Method::GET,
                            "/sessions/current",
                            None,
                        )
                        .await?;
                        let sid = snapshot["session"]["id"].as_str().map(str::to_owned);
                        update(&s, Some(&c.url), "connected", Some(snapshot), None);
                        sync_guests(&s).await;
                        let Some(sid) = sid else {
                            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                            return Ok::<(), Error>(());
                        };
                        let mut url = url::Url::parse(&c.url).map_err(|_| bad("URL inválida"))?;
                        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
                        url.set_scheme(scheme).map_err(|_| bad("URL inválida"))?;
                        url.set_path("/api/v1/events");
                        url.query_pairs_mut().append_pair("session_id", &sid);
                        let mut req = url
                            .as_str()
                            .into_client_request()
                            .map_err(|_| bad("No se pudo abrir el canal de control"))?;
                        req.headers_mut().insert(
                            "Authorization",
                            format!("Bearer {}", credential(&s, &c)?)
                                .parse()
                                .map_err(|_| bad("Credencial inválida"))?,
                        );
                        let (mut ws, _) = tokio::time::timeout(
                            std::time::Duration::from_secs(10),
                            tokio_tungstenite::connect_async(req),
                        )
                        .await
                        .map_err(|_| bad("El canal de control no responde"))?
                        .map_err(|_| bad("No se pudo conectar el canal de control"))?;
                        loop {
                            let msg =
                                tokio::time::timeout(std::time::Duration::from_secs(75), ws.next())
                                    .await
                                    .map_err(|_| bad("Se perdió el canal de control"))?;
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    let data: Value = serde_json::from_str(&text)
                                        .map_err(|_| bad("Mensaje del servidor inválido"))?;
                                    if data["type"]
                                        .as_str()
                                        .is_some_and(|t| t.starts_with("chat."))
                                    {
                                        let _ = s.chat_bus.0.send(data.clone());
                                    }
                                    if data["type"] == "snapshot" {
                                        let snapshot = data["data"].clone();
                                        let closed = snapshot["session"]["closed"] == true;
                                        update(
                                            &s,
                                            Some(&c.url),
                                            "connected",
                                            if closed { None } else { Some(snapshot) },
                                            None,
                                        );
                                        sync_guests(&s).await;
                                        if closed {
                                            return Ok(());
                                        }
                                    }
                                }
                                Some(Ok(Message::Ping(p))) => {
                                    ws.send(Message::Pong(p))
                                        .await
                                        .map_err(|_| bad("Se perdió el canal de control"))?;
                                }
                                Some(Ok(Message::Pong(_))) => {}
                                _ => return Err(bad("El canal de control se desconectó")),
                            }
                        }
                    };
                    let result = tokio::select! {_ = changes.changed()=>break,r=attempt=>r};
                    if let Err(e) = result {
                        let old = s.remote.state.lock().unwrap()["snapshot"].clone();
                        update(
                            &s,
                            Some(&c.url),
                            if e.0 == StatusCode::CONFLICT {
                                "incompatible"
                            } else {
                                "reconnecting"
                            },
                            (!old.is_null()).then_some(old),
                            Some(&e.1),
                        );
                        if tokio::select! {_ =changes.changed()=>true,_=tokio::time::sleep(std::time::Duration::from_secs(delay))=>false}
                        {
                            break;
                        }
                        delay = (delay * 2).min(30);
                    } else {
                        delay = 1;
                    }
                }
            } else {
                update(&s, None, "unconfigured", None, None);
                if changes.changed().await.is_err() {
                    break;
                }
            }
        }
    });
}

// A configured remote session remains selected during outages: never fall back
// to a different local conversation when its control connection is unavailable.
pub fn chat_selected(s: &App) -> bool {
    s.remote.state.lock().unwrap()["snapshot"]["session"]["id"].is_string()
}
pub async fn chat_request(
    s: &App,
    method: reqwest::Method,
    p: &crate::chat_store::Page,
    id: Option<&str>,
    body: Option<Value>,
) -> Result<Value, Error> {
    let c = configured(s).await?;
    let sid = current_id(s)?;
    if p.session_id.as_ref().is_some_and(|v| v != &sid)
        || body
            .as_ref()
            .and_then(|b| b["session_id"].as_str())
            .is_some_and(|v| v != sid)
    {
        return Err(Error(StatusCode::GONE, "La conversación cambió".into()));
    }
    let mut path = format!(
        "/chat/messages{}?session_id={sid}",
        id.map(|v| format!("/{v}")).unwrap_or_default()
    );
    if let Some(n) = p.after {
        path.push_str(&format!("&after={n}"));
    }
    if let Some(n) = p.before {
        path.push_str(&format!("&before={n}"));
    }
    request(&c.url, Some(credential(s, &c)?), method, &path, body).await
}
/// Archivos del chat remoto: el escritorio los sube y los descarga con sus
/// credenciales, con más tiempo que las peticiones de control.
async fn file_request(
    s: &App,
    sid: &str,
    q: reqwest::RequestBuilder,
) -> Result<reqwest::Response, Error> {
    if current_id(s)? != sid {
        return Err(Error(StatusCode::GONE, "La conversación cambió".into()));
    }
    let r = q
        .send()
        .await
        .map_err(|_| bad("No se pudo conectar con el servidor de sesiones"))?;
    if r.status().is_success() {
        return Ok(r);
    }
    let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let text = r
        .json::<Value>()
        .await
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "El servidor no pudo completar la operación".into());
    Err(Error(status, text))
}
fn file_client() -> Result<reqwest::Client, Error> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| bad("No se pudo crear la conexión"))
}
pub async fn chat_upload(
    s: &App,
    sid: &str,
    encoded_name: &str,
    bytes: Vec<u8>,
) -> Result<Value, Error> {
    let c = configured(s).await?;
    let q = file_client()?
        .post(format!("{}/api/v1/chat/files?session_id={sid}", c.url))
        .bearer_auth(credential(s, &c)?)
        .header("x-file-name", encoded_name)
        .header("content-type", "application/octet-stream")
        .body(bytes);
    file_request(s, sid, q)
        .await?
        .json()
        .await
        .map_err(|_| bad("El servidor no devolvió una respuesta válida"))
}
/// Devuelve tipo, nombre (Content-Disposition) y contenido de un archivo remoto.
pub async fn chat_file(s: &App, sid: &str, id: &str) -> Result<(String, String, Vec<u8>), Error> {
    let c = configured(s).await?;
    let q = file_client()?
        .get(format!("{}/api/v1/chat/files/{id}?session_id={sid}", c.url))
        .bearer_auth(credential(s, &c)?);
    let mut r = file_request(s, sid, q).await?;
    let header = |name| {
        r.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned()
    };
    let (mime, disposition) = (header("content-type"), header("content-disposition"));
    let mut bytes = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|_| bad("Descarga incompleta"))? {
        if bytes.len() + chunk.len() > crate::chat_store::MAX_FILE as usize {
            return Err(bad("Archivo demasiado grande"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((mime, disposition, bytes))
}
