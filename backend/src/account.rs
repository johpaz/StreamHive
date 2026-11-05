//! Quien maneja el estudio: perfil (nombre, estudio, rol) y la clave de acceso propia
//! de cada instalación, que sirve para entrar desde otro navegador o equipo.
use crate::{App, Error, Reply, bad, model::Profile, now, seal, session, unseal};
use argon2::{
    Argon2, PasswordHasher,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, header},
    response::IntoResponse,
};
use serde_json::json;

/// Clave guardada cifrada con la clave maestra, para poder mostrarla en Configuración.
const ACCESS_KEY: &str = "access_key";
/// Las sesiones de administrador emitidas antes de este instante dejan de valer.
pub const ADMIN_SINCE: &str = "admin_since";

/// Al arrancar, recuerda la clave inicial que entrega la app de escritorio si es la vigente.
pub fn remember_initial(
    store: &crate::store::Store,
    master: &[u8],
    password: &str,
    hash: &str,
) -> anyhow::Result<()> {
    use argon2::{PasswordHash, PasswordVerifier};
    let known = store.setting(ACCESS_KEY)?.filter(|v| !v.is_empty());
    if known.is_some() || password.is_empty() {
        return Ok(());
    }
    let matches = PasswordHash::new(hash).ok().is_some_and(|p| {
        Argon2::default()
            .verify_password(password.as_bytes(), &p)
            .is_ok()
    });
    if matches {
        store.set(ACCESS_KEY, &seal(master, password)?)?;
    }
    Ok(())
}
pub fn forget(store: &crate::store::Store) -> anyhow::Result<()> {
    store.set(ACCESS_KEY, "")
}

pub async fn profile_update(
    State(s): State<App>,
    h: HeaderMap,
    Json(mut body): Json<Profile>,
) -> Reply {
    s.admin(&h)?;
    body.validate().map_err(bad)?;
    let mut d = s.data.lock().await;
    d.profile = Some(body.clone());
    s.persist(&mut d)?;
    Ok(Json(json!(body)))
}

pub async fn access_view(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let sealed = s.store.lock().unwrap().setting(ACCESS_KEY)?;
    let key = sealed
        .filter(|v| !v.is_empty())
        .and_then(|v| unseal(&s.master, &v).ok());
    Ok(Json(
        json!({"key":key,"desktop":s.desktop_token_hash.is_some()}),
    ))
}

/// Clave legible para teclearla en otro equipo: 4 grupos de 5, sin caracteres ambiguos
/// (0/O, 1/I/L). Unos 99 bits de azar.
fn readable_key() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let mut rng = rand::rngs::OsRng;
    (0..4)
        .map(|_| {
            (0..5)
                .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("-")
}

/// Genera otra clave para esta app. Las sesiones de administrador abiertas con la
/// anterior (en otros navegadores o equipos) se cierran; quien la regenera sigue dentro.
pub async fn access_rotate(
    State(s): State<App>,
    h: HeaderMap,
) -> Result<axum::response::Response, Error> {
    s.admin(&h)?;
    let key = readable_key();
    let plain = key.clone();
    let hash = tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(plain.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
    })
    .await
    .map_err(|_| bad("No se pudo generar la clave"))?
    .map_err(|_| bad("No se pudo generar la clave"))?;
    let since = now();
    {
        let store = s.store.lock().unwrap();
        store.set("admin_hash", &hash)?;
        store.set(ACCESS_KEY, &seal(&s.master, &key)?)?;
        store.set(ADMIN_SINCE, &since.to_string())?;
    }
    *s.admin_hash.lock().unwrap() = hash;
    s.admin_since
        .store(since, std::sync::atomic::Ordering::SeqCst);
    Ok((
        [(
            header::SET_COOKIE,
            s.cookie(&session(&s.session_secret, "host", "admin"), 43200),
        )],
        Json(json!({"key":key})),
    )
        .into_response())
}
