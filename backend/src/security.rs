use crate::model::now;
use aes_gcm::{
    AeadCore, Aes256Gcm, KeyInit,
    aead::{Aead, OsRng},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub fn random() -> String {
    use rand::RngCore;
    let mut bytes = [0; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
pub fn hash(value: &str) -> String {
    STANDARD.encode(Sha256::digest(value.as_bytes()))
}
pub fn seal(key: &[u8], plaintext: &str) -> anyhow::Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| anyhow::anyhow!("key"))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let encrypted = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|_| anyhow::anyhow!("encrypt"))?;
    Ok(STANDARD.encode([nonce.as_slice(), &encrypted].concat()))
}
pub fn unseal(key: &[u8], value: &str) -> anyhow::Result<String> {
    let bytes = STANDARD.decode(value)?;
    anyhow::ensure!(bytes.len() >= 28, "invalid ciphertext");
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| anyhow::anyhow!("key"))?;
    let plain = cipher
        .decrypt(bytes[..12].into(), &bytes[12..])
        .map_err(|_| anyhow::anyhow!("decrypt"))?;
    Ok(String::from_utf8(plain)?)
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub role: String,
    pub exp: u64,
    pub iat: u64,
    pub iss: String,
}
pub fn session(secret: &str, sub: &str, role: &str) -> String {
    encode(
        &Header::default(),
        &Claims {
            sub: sub.into(),
            role: role.into(),
            exp: now() + 12 * 3600,
            iat: now(),
            iss: "streamhive".into(),
        },
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}
pub fn verify(secret: &str, token: &str) -> anyhow::Result<Claims> {
    let mut v = Validation::default();
    v.set_issuer(&["streamhive"]);
    Ok(decode::<Claims>(token, &DecodingKey::from_secret(secret.as_bytes()), &v)?.claims)
}
pub fn livekit_token(
    key: &str,
    secret: &str,
    identity: &str,
    name: &str,
    video: serde_json::Value,
) -> String {
    encode(&Header::default(),&serde_json::json!({"iss":key,"sub":identity,"name":name,"iat":now(),"nbf":now()-5,"exp":now()+180,"video":video}),&EncodingKey::from_secret(secret.as_bytes())).unwrap()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_destination_detects_tampering() {
        let key = [9; 32];
        let c = seal(&key, "rtmps://example/live/secret").unwrap();
        assert!(!c.contains("secret"));
        assert_eq!(unseal(&key, &c).unwrap(), "rtmps://example/live/secret");
        assert!(unseal(&[8; 32], &c).is_err());
        assert!(unseal(&key, "AA==").is_err());
    }
    #[test]
    fn sessions_are_signed_and_scoped() {
        let t = session("secret", "host", "admin");
        assert_eq!(verify("secret", &t).unwrap().role, "admin");
        assert!(verify("other", &t).is_err());
    }
}
