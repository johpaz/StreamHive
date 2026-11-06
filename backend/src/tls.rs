//! HTTPS local para invitados en la red: una CA propia de StreamHive (se genera una vez y se
//! guarda en DATA_DIR/tls) firma un certificado para las IPs/nombres del equipo. Los navegadores
//! solo dan cámara y micrófono en HTTPS, así que cada invitado debe confiar en esa CA
//! (se descarga en /ca.pem). La clave de la CA no sale del equipo.
use anyhow::Context;
use axum_server::tls_rustls::RustlsConfig;
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose,
};
use std::{fs, path::Path};
use time::{Duration, OffsetDateTime};

/// Parámetros de la CA. Se reconstruyen con la misma clave al recargar: el emisor de la cadena
/// se identifica por su nombre y clave, no por el número de serie.
fn ca_params() -> anyhow::Result<CertificateParams> {
    let mut p = CertificateParams::new(Vec::<String>::new())?;
    p.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    p.distinguished_name
        .push(DnType::CommonName, "StreamHive Local CA");
    p.distinguished_name
        .push(DnType::OrganizationName, "StreamHive");
    p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    Ok(p)
}

pub struct Tls {
    pub ca_pem: String,
    pub config: RustlsConfig,
}

fn write_secret(path: &Path, data: &str) -> anyhow::Result<()> {
    fs::write(path, data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// reqwest (ring) y axum-server (aws-lc) coexisten: rustls no elige solo y cualquier cliente
/// TLS sin proveedor propio (el canal de control wss:// del servidor de sesiones) entraría en
/// pánico. Se fija ring para todo el proceso, al arrancar.
pub fn provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Carga la CA y el certificado de `dir`, o los crea. El certificado se regenera si cambian los
/// nombres (p. ej. otra IP en la red) o le quedan menos de 30 días.
pub async fn load_or_create(dir: &Path, names: &[String]) -> anyhow::Result<Tls> {
    provider();
    fs::create_dir_all(dir)?;
    let (ca_pem_f, ca_key_f) = (dir.join("ca.pem"), dir.join("ca.key"));
    let (leaf_f, leaf_key_f, names_f) = (
        dir.join("leaf.pem"),
        dir.join("leaf.key"),
        dir.join("names.txt"),
    );

    if !ca_pem_f.exists() || !ca_key_f.exists() {
        let mut p = CertificateParams::new(Vec::<String>::new())?;
        p.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        p.distinguished_name
            .push(DnType::CommonName, "StreamHive Local CA");
        p.distinguished_name
            .push(DnType::OrganizationName, "StreamHive");
        p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        p.not_before = OffsetDateTime::now_utc() - Duration::days(1);
        p.not_after = OffsetDateTime::now_utc() + Duration::days(3650);
        let key = KeyPair::generate()?;
        let cert = p.self_signed(&key)?;
        fs::write(&ca_pem_f, cert.pem())?;
        write_secret(&ca_key_f, &key.serialize_pem())?;
        let _ = fs::remove_file(&leaf_f);
    }
    let ca_pem = fs::read_to_string(&ca_pem_f)?;
    let ca_key =
        KeyPair::from_pem(&fs::read_to_string(&ca_key_f)?).context("clave de la CA ilegible")?;
    let ca_cert = ca_params()?.self_signed(&ca_key)?;

    let wanted = {
        let mut n = names.to_vec();
        n.sort();
        n.dedup();
        n.join(",")
    };
    let fresh = leaf_f.exists()
        && leaf_key_f.exists()
        && fs::read_to_string(&names_f).is_ok_and(|n| n == wanted)
        && fs::metadata(&leaf_f)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() < 300 * 86400);
    if !fresh {
        let mut p = CertificateParams::new(names.to_vec())?;
        p.distinguished_name.push(DnType::CommonName, "StreamHive");
        p.is_ca = IsCa::NoCa;
        p.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyEncipherment,
        ];
        p.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        p.not_before = OffsetDateTime::now_utc() - Duration::days(1);
        p.not_after = OffsetDateTime::now_utc() + Duration::days(365);
        let key = KeyPair::generate()?;
        let cert = p.signed_by(&key, &ca_cert, &ca_key)?;
        fs::write(&leaf_f, cert.pem())?;
        write_secret(&leaf_key_f, &key.serialize_pem())?;
        fs::write(&names_f, &wanted)?;
    }
    let chain = format!("{}{}", fs::read_to_string(&leaf_f)?, ca_pem);
    let config = RustlsConfig::from_pem(chain.into_bytes(), fs::read(&leaf_key_f)?).await?;
    Ok(Tls { ca_pem, config })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn https_server_is_trusted_only_through_the_generated_ca_and_covers_the_lan_ip() {
        let dir = std::env::temp_dir().join(format!("sh-tls-{}", std::process::id()));
        let names = vec!["127.0.0.1".to_string(), "localhost".to_string()];
        let tls = load_or_create(&dir, &names).await.unwrap();
        let app = axum::Router::new().route("/ping", axum::routing::get(|| async { "pong" }));
        let addr = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap()
        };
        let handle = axum_server::Handle::new();
        tokio::spawn(
            axum_server::bind_rustls(addr, tls.config.clone())
                .handle(handle.clone())
                .serve(app.into_make_service()),
        );
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let trusted = reqwest::Client::builder()
            .add_root_certificate(reqwest::Certificate::from_pem(tls.ca_pem.as_bytes()).unwrap())
            .build()
            .unwrap();
        assert_eq!(
            trusted
                .get(format!("https://127.0.0.1:{}/ping", addr.port()))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "pong"
        );
        // Sin confiar en la CA, el navegador (aquí reqwest) rechaza el certificado.
        assert!(
            reqwest::Client::new()
                .get(format!("https://127.0.0.1:{}/ping", addr.port()))
                .send()
                .await
                .is_err()
        );
        // Cambiar los nombres regenera solo el certificado; la CA (y la confianza de los invitados) se conserva.
        let before = fs::read_to_string(dir.join("leaf.pem")).unwrap();
        let again = load_or_create(&dir, &names).await.unwrap();
        assert_eq!(fs::read_to_string(dir.join("leaf.pem")).unwrap(), before);
        let more = load_or_create(&dir, &["192.168.1.50".into(), "localhost".into()])
            .await
            .unwrap();
        assert_ne!(fs::read_to_string(dir.join("leaf.pem")).unwrap(), before);
        assert_eq!(more.ca_pem, again.ca_pem);
        // El certificado regenerado (firmado con la CA recargada) sigue siendo de confianza.
        let addr2 = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap()
        };
        let h2 = axum_server::Handle::new();
        let app2 = axum::Router::new().route("/ping", axum::routing::get(|| async { "pong2" }));
        tokio::spawn(
            axum_server::bind_rustls(addr2, more.config.clone())
                .handle(h2.clone())
                .serve(app2.into_make_service()),
        );
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let url = format!("https://localhost:{}/ping", addr2.port());
        assert_eq!(
            trusted.get(url).send().await.unwrap().text().await.unwrap(),
            "pong2"
        );
        h2.shutdown();
        handle.shutdown();
        fs::remove_dir_all(dir).ok();
    }
}
