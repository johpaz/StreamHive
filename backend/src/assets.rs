use crate::*;
use axum::body::Body;
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
const MAX_UPLOAD: u64 = 500 * 1024 * 1024;
const MAX_AUDIO: u64 = 50 * 1024 * 1024;

pub fn media_type(mime: &str, head: &[u8]) -> Option<(&'static str, &'static str)> {
    match mime {
        "image/png" if head.starts_with(b"\x89PNG\r\n\x1a\n") => Some(("image", "png")),
        "image/jpeg" if head.starts_with(b"\xff\xd8\xff") => Some(("image", "jpg")),
        "image/webp" if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP") => {
            Some(("image", "webp"))
        }
        "video/mp4" if head.get(4..8) == Some(b"ftyp") => Some(("video", "mp4")),
        "video/webm" if head.starts_with(b"\x1a\x45\xdf\xa3") => Some(("video", "webm")),
        "audio/mpeg"
            if head.starts_with(b"ID3")
                || (head.first() == Some(&0xff)
                    && head.get(1).is_some_and(|b| b & 0xe0 == 0xe0)) =>
        {
            Some(("audio", "mp3"))
        }
        "audio/ogg" if head.starts_with(b"OggS") => Some(("audio", "ogg")),
        "audio/wav" if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WAVE") => {
            Some(("audio", "wav"))
        }
        "audio/mp4" if head.get(4..8) == Some(b"ftyp") => Some(("audio", "m4a")),
        _ => None,
    }
}
pub async fn list(State(s): State<App>, h: HeaderMap) -> Reply {
    s.admin(&h)?;
    let d = s.data.lock().await;
    Ok(Json(json!(d.assets.values().collect::<Vec<_>>())))
}
pub async fn upload(State(s): State<App>, req: Request) -> Reply {
    s.admin(req.headers())?;
    let mime = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_owned();
    // Los navegadores no coinciden en el tipo de WAV y M4A.
    let mime = match mime.as_str() {
        "audio/mp3" => "audio/mpeg".to_owned(),
        "audio/x-wav" | "audio/wave" => "audio/wav".to_owned(),
        "audio/x-m4a" | "audio/m4a" => "audio/mp4".to_owned(),
        _ => mime,
    };
    if ![
        "image/png",
        "image/jpeg",
        "image/webp",
        "video/mp4",
        "video/webm",
        "audio/mpeg",
        "audio/ogg",
        "audio/wav",
        "audio/mp4",
    ]
    .contains(&mime.as_str())
    {
        return Err(bad(
            "Admite imágenes PNG/JPG/WebP, videos MP4/WebM y audio MP3/OGG/WAV/M4A",
        ));
    }
    let name = req
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| base64::engine::general_purpose::STANDARD.decode(v).ok())
        .and_then(|v| String::from_utf8(v).ok())
        .ok_or_else(|| bad("Nombre de archivo inválido"))?;
    if name.is_empty() || name.chars().count() > 180 || name.chars().any(|c| c.is_control()) {
        return Err(bad("Nombre de archivo inválido"));
    }
    let limit = if mime.starts_with("image/") {
        20 * 1024 * 1024
    } else if mime.starts_with("audio/") {
        MAX_AUDIO
    } else {
        MAX_UPLOAD
    };
    let length = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if length.is_some_and(|n| n > limit) {
        return Err(Error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Máximo 20 MB por imagen, 50 MB por audio y 500 MB por video".into(),
        ));
    }
    if fs2::available_space(&s.assets).map_err(|e| Error::from(anyhow::Error::new(e)))?
        < length.unwrap_or(limit) + 1_000_000_000
    {
        return Err(bad("Espacio insuficiente para subir el archivo"));
    }
    let identity = id();
    let temporary = s.assets.join(format!("{identity}.part"));
    let result: Result<Asset, Error> = async {
        let mut file = tokio::fs::File::create(&temporary)
            .await
            .map_err(|e| Error::from(anyhow::Error::new(e)))?;
        let mut stream = req.into_body().into_data_stream();
        let mut bytes = 0u64;
        let mut head = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| bad("Se interrumpió la subida; vuelve a intentarlo"))?;
            bytes += chunk.len() as u64;
            if bytes > limit {
                return Err(Error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "El archivo supera el tamaño permitido".into(),
                ));
            }
            if head.len() < 32 {
                head.extend_from_slice(&chunk[..chunk.len().min(32 - head.len())]);
            }
            file.write_all(&chunk)
                .await
                .map_err(|e| Error::from(anyhow::Error::new(e)))?;
        }
        let (kind, extension) = media_type(&mime, &head)
            .ok_or_else(|| bad("El contenido no coincide con un formato admitido"))?;
        file.flush()
            .await
            .map_err(|e| Error::from(anyhow::Error::new(e)))?;
        file.sync_all()
            .await
            .map_err(|e| Error::from(anyhow::Error::new(e)))?;
        drop(file);
        let filename = format!("{identity}.{extension}");
        let destination = s.assets.join(&filename);
        tokio::fs::rename(&temporary, &destination)
            .await
            .map_err(|e| Error::from(anyhow::Error::new(e)))?;
        let asset = Asset {
            id: identity.clone(),
            name,
            filename,
            mime,
            kind: kind.into(),
            bytes,
            created: now(),
        };
        let mut d = s.data.lock().await;
        d.assets.insert(identity.clone(), asset.clone());
        if let Err(e) = s.persist(&mut d) {
            let _ = tokio::fs::remove_file(destination).await;
            return Err(e);
        }
        Ok(asset)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(temporary).await;
    }
    Ok(Json(json!(result?)))
}
#[derive(Deserialize)]
pub struct AssetQuery {
    render_token: Option<String>,
}
pub async fn file(
    State(s): State<App>,
    Path(identity): Path<String>,
    Query(q): Query<AssetQuery>,
    h: HeaderMap,
) -> Result<Response, Error> {
    if let Some(token) = q.render_token {
        s.render_access(&token).await?;
        let d = s.data.lock().await;
        if ![&d.program, &d.portrait_program].iter().any(|p| {
            p.media_asset.as_deref() == Some(&identity)
                || p.background_asset.as_deref() == Some(&identity)
        }) && !d.slates.uses_asset(&identity)
        {
            return Err(denied());
        }
    } else {
        let c = s.participant(&h).await?;
        if c.role != "admin"
            && !s
                .data
                .lock()
                .await
                .participants
                .get(&c.sub)
                .is_some_and(|p| p.status == "admitted")
        {
            return Err(denied());
        }
    }
    let asset = s
        .data
        .lock()
        .await
        .assets
        .get(&identity)
        .cloned()
        .ok_or_else(|| bad("Archivo inexistente"))?;
    let mut request = Request::builder().uri("/");
    if let Some(range) = h.get(header::RANGE) {
        request = request.header(header::RANGE, range)
    }
    use tower::ServiceExt;
    let mut response = tower_http::services::ServeFile::new(s.assets.join(&asset.filename))
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .map_err(|e| Error::from(anyhow::anyhow!(e)))?
        .into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, asset.mime.parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    Ok(response)
}
pub async fn remove(State(s): State<App>, h: HeaderMap, Path(identity): Path<String>) -> Reply {
    s.admin(&h)?;
    let _guard = s.operations.lock().await;
    let mut d = s.data.lock().await;
    if [&d.program, &d.portrait_program]
        .into_iter()
        .chain(d.scenes.iter().map(|s| &s.program))
        .any(|p| {
            p.media_asset.as_deref() == Some(&identity)
                || p.background_asset.as_deref() == Some(&identity)
        })
    {
        return Err(bad("Retira el archivo del programa antes de eliminarlo"));
    }
    if d.slates.uses_asset(&identity) {
        return Err(bad(
            "Este archivo se usa en una pantalla de inicio, pausa o fin",
        ));
    }
    let asset = d
        .assets
        .get(&identity)
        .cloned()
        .ok_or_else(|| bad("Archivo inexistente"))?;
    let path = s.assets.join(&asset.filename);
    let temporary = s.assets.join(format!("{identity}.part"));
    let exists = tokio::fs::try_exists(&path)
        .await
        .map_err(|e| Error::from(anyhow::Error::new(e)))?;
    if exists {
        tokio::fs::rename(&path, &temporary)
            .await
            .map_err(|e| Error::from(anyhow::Error::new(e)))?;
    }
    d.assets.remove(&identity);
    if let Err(error) = s.persist(&mut d) {
        if exists {
            let _ = tokio::fs::rename(&temporary, &path).await;
        }
        return Err(error);
    }
    if exists {
        let _ = tokio::fs::remove_file(temporary).await;
    }
    Ok(Json(json!({"ok":true})))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_spoofed_or_executable_files() {
        assert!(media_type("image/png", b"<svg onload=alert(1)>").is_none());
        assert_eq!(
            media_type("image/png", b"\x89PNG\r\n\x1a\n"),
            Some(("image", "png"))
        );
        assert_eq!(
            media_type("video/mp4", b"\0\0\0\x20ftypisom"),
            Some(("video", "mp4"))
        );
    }
    #[test]
    fn audio_is_recognised_by_its_content() {
        assert_eq!(media_type("audio/mpeg", b"ID3\x04"), Some(("audio", "mp3")));
        assert_eq!(
            media_type("audio/mpeg", b"\xff\xfb\x90"),
            Some(("audio", "mp3"))
        );
        assert_eq!(media_type("audio/ogg", b"OggS\0"), Some(("audio", "ogg")));
        assert_eq!(
            media_type("audio/wav", b"RIFF\0\0\0\0WAVEfmt "),
            Some(("audio", "wav"))
        );
        assert_eq!(
            media_type("audio/mp4", b"\0\0\0\x20ftypM4A "),
            Some(("audio", "m4a"))
        );
        assert!(media_type("audio/mpeg", b"<script>alert(1)").is_none());
        assert!(media_type("audio/wav", b"RIFF\0\0\0\0WEBPVP8 ").is_none());
    }
}
