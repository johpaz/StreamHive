use std::{path::PathBuf, time::Duration};
use streamhive_sessions::{App, Config, media, router};
fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.into())
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(env("RUST_LOG", "streamhive_sessions=info"))
        .init();
    let args: Vec<_> = std::env::args().collect();
    let addr = env("LISTEN_ADDR", "0.0.0.0:8080");
    if args.get(1).is_some_and(|s| s == "healthcheck") {
        let port = addr.rsplit(':').next().unwrap_or("8080");
        reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()?
            .get(format!("http://127.0.0.1:{port}/readyz"))
            .send()
            .await?
            .error_for_status()?;
        return Ok(());
    }
    let path = PathBuf::from(env("DATA_DIR", "/data")).join("sessions.sqlite");
    if args.get(1).is_some_and(|s| s == "backup") {
        let target = args.get(2).ok_or_else(|| {
            anyhow::anyhow!("Usage: streamhive-sessions backup /data/backup.sqlite")
        })?;
        let c = rusqlite::Connection::open(path)?;
        c.execute("VACUUM INTO ?1", [target])?;
        return Ok(());
    }
    let mut config = Config::new(&env("PUBLIC_URL", "http://localhost:8080"), path)?;
    config.registrations_per_hour = env("REGISTRATIONS_PER_HOUR", "120").parse()?;
    config.requests_per_minute = env("REQUESTS_PER_MINUTE", "600").parse()?;
    config.max_connections = env("MAX_CONNECTIONS", "1000").parse()?;
    config.trust_proxy = env("TRUST_PROXY", "false") == "true";
    // Efectos de cámara y fondos del estudio para los invitados (la imagen los trae en esta carpeta).
    let assets = PathBuf::from(env("ASSETS_DIR", "/usr/share/streamhive-sessions"));
    if assets.join("effects/loader.mjs").is_file() {
        config.assets = Some(assets);
    } else {
        tracing::warn!(dir = %assets.display(), "Camera effects not found: guests get none");
    }
    // Claves y configuración de LiveKit: un volumen aparte, que el contenedor de LiveKit monta sin la base de datos.
    let media_dir = PathBuf::from(env("MEDIA_DIR", &env("DATA_DIR", "/data")));
    let migrate = args.get(1).is_some_and(|s| s == "migrate");
    // Medios (cámara y audio): LiveKit en el mismo compose. Sin LIVEKIT_URL, solo espera y chat.
    let livekit = env("LIVEKIT_URL", "");
    if !livekit.is_empty() {
        let ports = media::Ports {
            udp: env("MEDIA_UDP_PORT", "7882").parse()?,
            tcp: env("MEDIA_TCP_PORT", "7881").parse()?,
        };
        let ip = env("MEDIA_PUBLIC_IP", "");
        if migrate {
            media::setup(
                &media_dir,
                &livekit,
                &ports,
                Some(ip.as_str()).filter(|v| !v.is_empty()),
            )?;
            tracing::info!(udp = ports.udp, tcp = ports.tcp, "Media ready");
        } else {
            config.media = Some(media::Media::load(&media_dir, &livekit, ports)?);
        }
    }
    let state = App::open(config)?;
    if migrate {
        tracing::info!("Database ready");
        return Ok(());
    }
    let worker = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            if worker.prune().await.is_err() {
                tracing::warn!("Session cleanup failed");
            }
        }
    });
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr,"Sessions service ready");
    axum::serve(
        listener,
        router(state.clone()).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        state.stop();
    })
    .await?;
    Ok(())
}
