//! Dónde está la sala de cámara y audio: el LiveKit local de este equipo o el del servidor de
//! sesiones ("medios en el servidor"). Con el servidor, esta app no conoce la clave de LiveKit:
//! pide al servidor permisos limitados a su propia sala y administra la sala a través de `/lk`.
use crate::{App, Error, model::OutputFormat, model::ROOM, now, remote};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Value, json};

/// Servidor de sesiones con medios en uso: (URL, credencial de la instalación).
pub fn server(s: &App) -> Option<(String, String)> {
    remote::media_target(s)
}
pub fn is_remote(s: &App) -> bool {
    server(s).is_some()
}

async fn grant(s: &App, body: Value) -> Result<Value, Error> {
    let (url, credential) = server(s).ok_or_else(|| crate::bad("Servidor sin medios"))?;
    let r =
        s.lk.client
            .post(format!("{url}/api/v1/media/token"))
            .bearer_auth(credential)
            .json(&body)
            .send()
            .await
            .map_err(|_| unavailable())?;
    if !r.status().is_success() {
        return Err(unavailable());
    }
    r.json().await.map_err(|_| unavailable())
}
fn unavailable() -> Error {
    Error(
        StatusCode::BAD_GATEWAY,
        "El servidor de sesiones no responde: la cámara y el audio van por él".into(),
    )
}

/// Permiso de administración de la sala propia, reutilizado hasta un minuto antes de caducar.
async fn admin(s: &App) -> Result<(String, String), Error> {
    let url = server(s).map(|x| x.0).unwrap_or_default();
    if let Some((u, token, room, exp)) = s.remote.media_admin.lock().unwrap().clone() {
        if u == url && exp > now() + 60 {
            return Ok((token, room));
        }
    }
    let g = grant(s, json!({"role":"admin"})).await?;
    let (token, room) = (
        g["token"].as_str().unwrap_or_default().to_owned(),
        g["room"].as_str().unwrap_or_default().to_owned(),
    );
    let exp = g["expires"].as_u64().unwrap_or(now() + 300);
    *s.remote.media_admin.lock().unwrap() = Some((url, token.clone(), room.clone(), exp));
    Ok((token, room))
}

/// Llamada a RoomService sobre la sala del estudio (el campo `room` se ajusta a la sala real).
pub async fn rpc(s: &App, method: &str, mut body: Value) -> anyhow::Result<Value> {
    let Some((url, _)) = server(s) else {
        return s.lk.rpc("RoomService", method, body).await;
    };
    let (token, room) = admin(s).await.map_err(|e| anyhow::anyhow!(e.1))?;
    if body.get("room").is_some() {
        body["room"] = json!(room);
    }
    let r =
        s.lk.client
            .post(format!("{url}/lk/twirp/livekit.RoomService/{method}"))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await?;
    anyhow::ensure!(
        r.status().is_success(),
        "LiveKit RoomService/{method}: HTTP {}",
        r.status()
    );
    Ok(r.json().await?)
}

/// ¿Responde la sala? En local, LiveKit; con el servidor, su sala (aún vacía cuenta como lista).
pub async fn healthy(s: &App) -> bool {
    if !is_remote(s) {
        return s
            .lk
            .rpc("RoomService", "ListRooms", json!({"names":[ROOM]}))
            .await
            .is_ok();
    }
    match rpc(s, "ListParticipants", json!({"room":ROOM})).await {
        Ok(_) => true,
        Err(e) => e.to_string().contains("HTTP 404"),
    }
}

/// Permiso para entrar con cámara y audio (anfitrión e invitados locales).
pub async fn join(s: &App, h: &HeaderMap, identity: &str, name: &str) -> Result<Value, Error> {
    if !is_remote(s) {
        return Ok(json!({"token":s.lk.join_token(identity,name),"url":s.livekit_url(h)}));
    }
    let g = grant(
        s,
        json!({"role":"publisher","identity":identity,"name":name}),
    )
    .await?;
    Ok(json!({"token":g["token"],"url":g["url"]}))
}

/// Permiso del compositor oculto (solo recibe).
pub async fn recorder(s: &App, h: &HeaderMap, format: OutputFormat) -> Result<Value, Error> {
    if !is_remote(s) {
        return Ok(json!({"url":s.livekit_url(h),"token":s.lk.recorder_token_for(format)}));
    }
    let identity = if format == OutputFormat::Portrait {
        "EG_recorder_portrait"
    } else {
        "EG_recorder"
    };
    let g = grant(
        s,
        json!({"role":"recorder","identity":identity,"name":"Compositor"}),
    )
    .await?;
    Ok(json!({"token":g["token"],"url":g["url"]}))
}

pub async fn remove(s: &App, identity: &str) -> anyhow::Result<()> {
    rpc(
        s,
        "RemoveParticipant",
        json!({"room":ROOM,"identity":identity}),
    )
    .await?;
    Ok(())
}
