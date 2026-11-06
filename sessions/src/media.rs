//! Medios en el servidor: LiveKit corre en la red interna del compose y solo se llega a él
//! a través de este servicio (`/lk`). La clave de LiveKit no sale de aquí: cada instalación
//! recibe permisos limitados a su propia sala y cada invitado solo al ser admitido.
use crate::{App, Error, Result, denied, guest, invalid, now, owner, secret};
use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use jsonwebtoken::{EncodingKey, Header, encode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path as FsPath;
use std::sync::atomic::Ordering;

/// Puertos de vídeo y audio (WebRTC). No pueden pasar por el proxy HTTPS: el compose los publica.
#[derive(Clone, Debug, PartialEq)]
pub struct Ports {
    pub udp: u16,
    pub tcp: u16,
}

#[derive(Clone)]
pub struct Media {
    endpoint: String,
    key: String,
    secret: String,
    pub ports: Ports,
    client: reqwest::Client,
}

#[derive(Serialize, Deserialize)]
struct Keys {
    key: String,
    secret: String,
}
const KEYS: &str = "livekit-keys.json";
pub const CONFIG: &str = "livekit.yaml";

/// Prepara LiveKit en el volumen de datos: crea sus claves la primera vez (nadie las teclea)
/// y escribe su configuración con los puertos actuales. Se ejecuta en `migrate`.
pub fn setup(
    dir: &FsPath,
    endpoint: &str,
    ports: &Ports,
    public_ip: Option<&str>,
) -> anyhow::Result<()> {
    let port = url::Url::parse(endpoint)?
        .port_or_known_default()
        .ok_or_else(|| anyhow::anyhow!("LIVEKIT_URL needs a port"))?;
    std::fs::create_dir_all(dir)?;
    let file = dir.join(KEYS);
    let keys: Keys = match std::fs::read(&file) {
        Ok(raw) => serde_json::from_slice(&raw)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let keys = Keys {
                key: format!("sh{}", &secret()[..14].replace(['-', '_'], "x")),
                secret: secret(),
            };
            write_private(&file, &serde_json::to_vec(&keys)?)?;
            keys
        }
        Err(e) => return Err(e.into()),
    };
    if let Some(ip) = public_ip {
        anyhow::ensure!(
            ip.parse::<std::net::IpAddr>().is_ok(),
            "MEDIA_PUBLIC_IP must be an IP address"
        );
    }
    // Sin IP fija, LiveKit descubre la IP pública del VPS por STUN.
    let address = match public_ip {
        Some(ip) => format!("  node_ip: {ip}\n  use_external_ip: false\n"),
        None => "  use_external_ip: true\n".into(),
    };
    let config = format!(
        "# Generado por streamhive-sessions migrate; se reescribe en cada arranque.\n\
         port: {port}\n\
         bind_addresses: [\"0.0.0.0\"]\n\
         rtc:\n  tcp_port: {}\n  udp_port: {}\n{address}\
         keys:\n  {}: {}\n\
         room:\n  empty_timeout: 300\n  departure_timeout: 20\n\
         logging:\n  level: info\n",
        ports.tcp, ports.udp, keys.key, keys.secret
    );
    write_private(&dir.join(CONFIG), config.as_bytes())
}
fn write_private(path: &FsPath, bytes: &[u8]) -> anyhow::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(tmp, path)?;
    Ok(())
}

impl Media {
    pub fn load(dir: &FsPath, endpoint: &str, ports: Ports) -> anyhow::Result<Self> {
        let keys: Keys = serde_json::from_slice(&std::fs::read(dir.join(KEYS)).map_err(|e| {
            anyhow::anyhow!("{e}: run `streamhive-sessions migrate` before starting")
        })?)?;
        Ok(Self {
            endpoint: endpoint.trim_end_matches('/').into(),
            key: keys.key,
            secret: keys.secret,
            ports,
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }
    fn token(&self, identity: &str, name: &str, video: Value, ttl: i64) -> String {
        encode(
            &Header::default(),
            &json!({"iss":self.key,"sub":identity,"name":name,"iat":now(),"nbf":now()-5,"exp":now()+ttl,"video":video}),
            &EncodingKey::from_secret(self.secret.as_bytes()),
        )
        .expect("HS256 encoding")
    }
    async fn rpc(&self, method: &str, video: Value, body: Value) -> anyhow::Result<()> {
        let r = self
            .client
            .post(format!(
                "{}/twirp/livekit.RoomService/{method}",
                self.endpoint
            ))
            .bearer_auth(self.token("streamhive-sessions", "", video, 60))
            .json(&body)
            .send()
            .await?;
        // Sala o participante que ya no existe: no hay nada que cerrar.
        anyhow::ensure!(
            r.status().is_success() || r.status() == reqwest::StatusCode::NOT_FOUND,
            "LiveKit {method}: HTTP {}",
            r.status()
        );
        Ok(())
    }
    /// Saca a un invitado de la sala al retirarlo o rechazarlo (sin esperar a que caduque su permiso).
    /// Reintenta una vez; `false` si LiveKit no lo confirmó (el invitado ya no puede pedir otro permiso).
    pub async fn kick(&self, oid: &str, pid: &str) -> bool {
        let room = room(oid);
        for attempt in 0..2 {
            match self
                .rpc(
                    "RemoveParticipant",
                    json!({"roomAdmin":true,"room":room}),
                    json!({"room":room,"identity":guest_identity(pid)}),
                )
                .await
            {
                Ok(()) => return true,
                Err(e) => {
                    tracing::warn!("{e}");
                    if attempt == 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    }
                }
            }
        }
        false
    }
    /// Al cerrar la sesión remota se cierra la sala: nadie queda conectado.
    pub async fn close(&self, oid: &str) {
        if let Err(e) = self
            .rpc(
                "DeleteRoom",
                json!({"roomCreate":true}),
                json!({"room":room(oid)}),
            )
            .await
        {
            tracing::warn!("{e}");
        }
    }
    pub async fn ready(&self) -> bool {
        self.client
            .get(format!("{}/", self.endpoint))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
    }
}

/// Una sala por instalación: varios estudios pueden compartir el mismo servidor.
pub fn room(oid: &str) -> String {
    format!("sh-{oid}")
}
pub fn guest_identity(pid: &str) -> String {
    format!("g-{pid}")
}
const PUBLISH: [&str; 4] = ["camera", "microphone", "screen_share", "screen_share_audio"];
fn publisher(room: &str) -> Value {
    json!({"roomJoin":true,"room":room,"canPublish":true,"canPublishData":false,"canSubscribe":true,"canUpdateOwnMetadata":false,"canPublishSources":PUBLISH})
}
pub fn signal_url(public_url: &str) -> String {
    format!("{}/lk", public_url.replacen("http", "ws", 1))
}

#[derive(Deserialize)]
pub struct TokenRequest {
    identity: Option<String>,
    #[serde(default)]
    name: String,
    role: String,
}
/// Las identidades de la instalación no pueden hacerse pasar por invitados del servidor (`g-…`).
fn valid_identity(identity: &str) -> bool {
    (1..=64).contains(&identity.len())
        && identity
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && !identity.starts_with("g-")
}
fn media(s: &App) -> Result<&Media> {
    s.media.as_ref().ok_or(Error(
        StatusCode::NOT_IMPLEMENTED,
        "Este servidor no tiene medios (cámara y audio)",
    ))
}

/// Permisos de la app de escritorio para su sala: entrar y publicar (anfitrión e invitados
/// locales), el compositor oculto, o administrar la sala (silenciar, retirar, listar).
pub async fn token(
    State(s): State<App>,
    h: HeaderMap,
    Json(b): Json<TokenRequest>,
) -> Result<Json<Value>> {
    let oid = owner(&s, &h).await?;
    let m = media(&s)?;
    let room = room(&oid);
    if b.name.chars().count() > 60 || b.name.chars().any(char::is_control) {
        return Err(invalid("Nombre: hasta 60 caracteres"));
    }
    let identity = b.identity.as_deref().unwrap_or("");
    let token = match b.role.as_str() {
        "publisher" if valid_identity(identity) => {
            m.token(identity, &b.name, publisher(&room), 600)
        }
        "recorder" if valid_identity(identity) && identity.starts_with("EG_") => m.token(
            identity,
            &b.name,
            json!({"roomJoin":true,"room":room,"canPublish":false,"canPublishData":false,"canSubscribe":true,"hidden":true}),
            600,
        ),
        "admin" => m.token(
            "streamhive-app",
            "",
            json!({"roomAdmin":true,"room":room}),
            600,
        ),
        _ => return Err(invalid("Permiso o identidad inválidos")),
    };
    Ok(Json(
        json!({"token":token,"url":signal_url(&s.config.public_url),"room":room,"expires":now()+600}),
    ))
}

/// Permiso del invitado: solo cuando el anfitrión lo admitió, y solo para la sala de esa sesión.
pub async fn guest_token(State(s): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let (sid, pid) = guest(&s, &h).await?;
    let m = media(&s)?;
    let key = pid.clone();
    let (oid, name, status): (String, String, String) = s
        .db(move |c| {
            Ok(c.query_row(
                "SELECT s.installation_id,p.name,p.status FROM participants p JOIN sessions s ON s.id=p.session_id WHERE p.id=?1 AND s.id=?2",
                rusqlite::params![key, sid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?)
        })
        .await?;
    if status != "admitted" {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "Espera a que te admita el anfitrión",
        ));
    }
    let room = room(&oid);
    Ok(Json(json!({
        "token": m.token(&guest_identity(&pid), &name, publisher(&room), 600),
        "url": signal_url(&s.config.public_url),
    })))
}

/// Llamadas de administración que la app puede hacer sobre su sala. LiveKit comprueba que el
/// permiso sea `roomAdmin` de esa misma sala; las globales (listar o crear salas) no pasan.
const ROOM_METHODS: [&str; 4] = [
    "ListParticipants",
    "GetParticipant",
    "MutePublishedTrack",
    "RemoveParticipant",
];
pub fn allowed_path(rest: &str) -> bool {
    rest == "rtc"
        || rest.starts_with("rtc/")
        || rest
            .strip_prefix("twirp/livekit.RoomService/")
            .is_some_and(|m| ROOM_METHODS.contains(&m))
}

/// Única puerta a LiveKit: señalización (WebSocket `rtc`) y administración de la propia sala.
/// El vídeo y el audio no pasan por aquí: van directos a los puertos UDP/TCP publicados.
pub async fn proxy(
    State(s): State<App>,
    Path(rest): Path<String>,
    mut req: Request,
) -> Result<Response> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        WebSocketStream, connect_async,
        tungstenite::{Message, handshake::derive_accept_key, protocol::Role},
    };
    let m = media(&s)?.clone();
    if !allowed_path(&rest) {
        return Err(Error(StatusCode::NOT_FOUND, "No encontrado"));
    }
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let upstream = format!("{}/{rest}{query}", m.endpoint);
    let h = req.headers().clone();
    if rest.starts_with("twirp/") {
        let body = axum::body::to_bytes(std::mem::take(req.body_mut()), 16384)
            .await
            .map_err(|_| invalid("Solicitud demasiado grande"))?;
        let mut up = m.client.post(&upstream).body(body);
        for name in [header::AUTHORIZATION, header::CONTENT_TYPE] {
            if let Some(v) = h.get(&name) {
                up = up.header(name.as_str(), v.as_bytes());
            }
        }
        return relay(up.send().await).await;
    }
    let is_ws = h
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    if !is_ws {
        return relay(m.client.get(&upstream).send().await).await;
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
    let up = match connect_async(upstream.replacen("http", "ws", 1)).await {
        Ok((up, _)) => up,
        Err(_) => {
            s.connections.fetch_sub(1, Ordering::SeqCst);
            return Err(Error(StatusCode::BAD_GATEWAY, "Medios no disponibles"));
        }
    };
    let upgrade = hyper::upgrade::on(&mut req);
    let connections = s.connections.clone();
    tokio::spawn(async move {
        if let Ok(stream) = upgrade.await {
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
        }
        connections.fetch_sub(1, Ordering::SeqCst);
    });
    Ok(Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, "websocket")
        .header("sec-websocket-accept", accept)
        .body(Body::empty())
        .unwrap())
}
async fn relay(r: reqwest::Result<reqwest::Response>) -> Result<Response> {
    let r = r.map_err(|_| Error(StatusCode::BAD_GATEWAY, "Medios no disponibles"))?;
    let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let kind = r.headers().get(reqwest::header::CONTENT_TYPE).cloned();
    let body: Bytes = r
        .bytes()
        .await
        .map_err(|_| Error(StatusCode::BAD_GATEWAY, "Medios no disponibles"))?;
    let mut out = (status, body).into_response();
    if let Some(k) = kind.and_then(|k| header::HeaderValue::from_bytes(k.as_bytes()).ok()) {
        out.headers_mut().insert(header::CONTENT_TYPE, k);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_signaling_and_own_room_administration_pass() {
        for ok in [
            "rtc",
            "rtc/validate",
            "rtc/v1",
            "twirp/livekit.RoomService/ListParticipants",
            "twirp/livekit.RoomService/MutePublishedTrack",
            "twirp/livekit.RoomService/RemoveParticipant",
        ] {
            assert!(allowed_path(ok), "{ok}");
        }
        for no in [
            "",
            "debug/pprof",
            "rtcx",
            "twirp/livekit.RoomService/ListRooms",
            "twirp/livekit.RoomService/CreateRoom",
            "twirp/livekit.RoomService/DeleteRoom",
            "twirp/livekit.Egress/StartRoomCompositeEgress",
            "twirp/livekit.RoomService/ListParticipants/../ListRooms",
        ] {
            assert!(!allowed_path(no), "{no}");
        }
    }
    #[test]
    fn the_app_cannot_impersonate_server_guests() {
        assert!(valid_identity("host"));
        assert!(valid_identity("EG_recorder_portrait"));
        assert!(!valid_identity("g-123"));
        assert!(!valid_identity(""));
        assert!(!valid_identity("a b"));
        assert!(!valid_identity(&"x".repeat(65)));
    }
    #[test]
    fn setup_keeps_keys_and_rewrites_ports() {
        let dir = std::env::temp_dir().join(format!("sh-media-{}", crate::id()));
        let ports = Ports {
            udp: 7882,
            tcp: 7881,
        };
        setup(&dir, "http://livekit:7880", &ports, None).unwrap();
        let keys = std::fs::read(dir.join(KEYS)).unwrap();
        let config = std::fs::read_to_string(dir.join(CONFIG)).unwrap();
        assert!(config.contains("port: 7880") && config.contains("udp_port: 7882"));
        assert!(config.contains("use_external_ip: true"));
        let ports = Ports {
            udp: 9000,
            tcp: 9001,
        };
        setup(&dir, "http://livekit:7880", &ports, Some("203.0.113.7")).unwrap();
        assert_eq!(std::fs::read(dir.join(KEYS)).unwrap(), keys, "keys rotated");
        let config = std::fs::read_to_string(dir.join(CONFIG)).unwrap();
        assert!(config.contains("udp_port: 9000") && config.contains("node_ip: 203.0.113.7"));
        assert!(setup(&dir, "http://livekit:7880", &ports, Some("evil\nkeys:")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
