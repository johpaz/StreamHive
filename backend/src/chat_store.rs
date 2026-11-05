//! Durable chat shared by the desktop backend and the session service.
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug)]
pub enum Failure {
    Database(rusqlite::Error),
    Invalid(&'static str),
    Limited,
    Closed,
    TooLarge,
    Io(String),
}
impl From<rusqlite::Error> for Failure {
    fn from(e: rusqlite::Error) -> Self {
        Self::Database(e)
    }
}
pub type Result<T> = std::result::Result<T, Failure>;
#[derive(Clone)]
pub struct Bus(pub tokio::sync::broadcast::Sender<Value>);
impl Default for Bus {
    fn default() -> Self {
        Self(tokio::sync::broadcast::channel(64).0)
    }
}
impl Bus {
    pub fn notify(&self, conversation: &str, kind: &str) {
        let _ = self
            .0
            .send(json!({"type":kind,"conversation_id":conversation}));
    }
}
#[derive(Deserialize, Clone, Default)]
pub struct Page {
    pub session_id: Option<String>,
    pub after: Option<i64>,
    pub before: Option<i64>,
}
#[derive(Deserialize, serde::Serialize, Clone)]
pub struct Send {
    pub session_id: String,
    pub client_message_id: String,
    #[serde(default)]
    pub text: String,
    /// Archivo subido antes con `POST /chat/files`; el mensaje puede no llevar texto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_id: Option<String>,
}
/// Materiales del chat: 25 MB por archivo y 200 MB por conversación.
pub const MAX_FILE: u64 = 25 * 1024 * 1024;
pub const MAX_CONVERSATION_FILES: i64 = 200 * 1024 * 1024;
/// Tipo real del archivo por su firma (y la extensión para distinguir formatos ZIP).
/// Nada ejecutable: solo documentos, imágenes, texto y ZIP.
pub fn sniff(name: &str, head: &[u8]) -> Option<&'static str> {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    if head.starts_with(b"%PDF-") {
        return Some("application/pdf");
    }
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if head.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP") {
        return Some("image/webp");
    }
    if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") {
        return Some(match ext.as_str() {
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "odt" => "application/vnd.oasis.opendocument.text",
            "ods" => "application/vnd.oasis.opendocument.spreadsheet",
            "odp" => "application/vnd.oasis.opendocument.presentation",
            "zip" => "application/zip",
            _ => return None,
        });
    }
    if matches!(ext.as_str(), "txt" | "csv" | "md") && !head.contains(&0) {
        // Puede cortarse a mitad de un carácter: basta con que el resto sea UTF-8.
        let ok = match std::str::from_utf8(head) {
            Ok(_) => true,
            Err(e) => e.error_len().is_none(),
        };
        if ok {
            return Some(if ext == "csv" {
                "text/csv"
            } else {
                "text/plain"
            });
        }
    }
    None
}
pub fn valid_file_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.chars().count() <= 180
        && !name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
}
/// Guarda el cuerpo de la petición en `dir/<id>` sin pasar de [`MAX_FILE`].
/// Devuelve el tamaño y los primeros bytes para reconocer el tipo.
pub async fn receive(
    body: axum::body::Body,
    dir: &std::path::Path,
    id: &str,
) -> Result<(u64, Vec<u8>)> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let io = |e: std::io::Error| Failure::Io(e.to_string());
    tokio::fs::create_dir_all(dir).await.map_err(io)?;
    let part = dir.join(format!("{id}.part"));
    let result = async {
        let mut file = tokio::fs::File::create(&part).await.map_err(io)?;
        let mut stream = body.into_data_stream();
        let (mut size, mut head) = (0u64, Vec::new());
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| Failure::Invalid("Se interrumpió la subida"))?;
            size += chunk.len() as u64;
            if size > MAX_FILE {
                return Err(Failure::TooLarge);
            }
            if head.len() < 4096 {
                head.extend_from_slice(&chunk[..chunk.len().min(4096 - head.len())]);
            }
            file.write_all(&chunk).await.map_err(io)?;
        }
        if size == 0 {
            return Err(Failure::Invalid("El archivo está vacío"));
        }
        file.sync_all().await.map_err(io)?;
        tokio::fs::rename(&part, dir.join(id)).await.map_err(io)?;
        Ok((size, head))
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
    }
    result
}
/// Respuesta de descarga: siempre como adjunto, para que nada se abra dentro del estudio.
pub fn download(name: &str, mime: &str, bytes: Vec<u8>) -> axum::response::Response {
    use axum::http::header;
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || " ._-()".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b".-_~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    axum::response::Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}"),
        )
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "sandbox; default-src 'none'",
        )
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(axum::body::Body::from(bytes))
        .unwrap()
}
pub fn init(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS chat_conversations(id TEXT PRIMARY KEY, closed_at INTEGER);
      CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, sender_role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, client_message_id TEXT NOT NULL, UNIQUE(conversation_id,sender_id,client_message_id));
      CREATE TABLE IF NOT EXISTS chat_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, kind TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_event_cursor ON chat_events(conversation_id,sequence);
      CREATE INDEX IF NOT EXISTS chat_message_rate ON chat_messages(conversation_id,sender_id,created_at);
      CREATE TABLE IF NOT EXISTS chat_files(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE, uploader_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, message_id TEXT);
      CREATE INDEX IF NOT EXISTS chat_files_conversation ON chat_files(conversation_id,uploader_id,created_at);")?;
    let has_attachment: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('chat_messages') WHERE name='attachment_id')",
        [],
        |r| r.get(0),
    )?;
    if !has_attachment {
        c.execute_batch("ALTER TABLE chat_messages ADD COLUMN attachment_id TEXT")?;
    }
    Ok(())
}
pub fn ensure(c: &Connection, sid: &str) -> rusqlite::Result<()> {
    c.execute(
        "INSERT OR IGNORE INTO chat_conversations(id) VALUES(?1)",
        [sid],
    )?;
    Ok(())
}
pub fn local(c: &Connection) -> rusqlite::Result<String> {
    let active: Option<String> = c
        .query_row(
            "SELECT id FROM chat_conversations WHERE closed_at IS NULL ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = active {
        return Ok(id);
    }
    let sid = uuid::Uuid::new_v4().to_string();
    ensure(c, &sid)?;
    Ok(sid)
}
pub fn close(c: &Connection, sid: &str, now: i64) -> rusqlite::Result<()> {
    c.execute(
        "UPDATE chat_conversations SET closed_at=COALESCE(closed_at,?2) WHERE id=?1",
        params![sid, now],
    )?;
    Ok(())
}
pub fn prune(c: &Connection, now: i64) -> rusqlite::Result<()> {
    // Explicit deletes also support databases created before foreign_keys was enabled.
    c.execute("DELETE FROM chat_events WHERE conversation_id IN (SELECT id FROM chat_conversations WHERE closed_at <= ?1)", [now-86400])?;
    c.execute("DELETE FROM chat_messages WHERE conversation_id IN (SELECT id FROM chat_conversations WHERE closed_at <= ?1)", [now-86400])?;
    c.execute("DELETE FROM chat_files WHERE conversation_id IN (SELECT id FROM chat_conversations WHERE closed_at <= ?1)", [now-86400])?;
    // Subidas que nunca se enviaron.
    c.execute(
        "DELETE FROM chat_files WHERE message_id IS NULL AND created_at <= ?1",
        [now - 3600],
    )?;
    c.execute(
        "DELETE FROM chat_conversations WHERE closed_at <= ?1",
        [now - 86400],
    )?;
    Ok(())
}
fn message(c: &Connection, id: &str) -> rusqlite::Result<Value> {
    c.query_row("SELECT m.id,m.conversation_id,m.sender_id,m.sender_name,m.sender_role,m.text,m.created_at,m.deleted,m.client_message_id,(SELECT MIN(sequence) FROM chat_events WHERE message_id=m.id),f.id,f.name,f.mime,f.size FROM chat_messages m LEFT JOIN chat_files f ON f.id=m.attachment_id AND f.message_id=m.id WHERE m.id=?1",[id],|r| {
        let deleted = r.get::<_,bool>(7)?;
        let attachment = match (deleted, r.get::<_,Option<String>>(10)?) {
            (false, Some(file)) => json!({"id":file,"name":r.get::<_,String>(11)?,"mime":r.get::<_,String>(12)?,"size":r.get::<_,i64>(13)?}),
            _ => Value::Null,
        };
        Ok(json!({"id":r.get::<_,String>(0)?,"conversation_id":r.get::<_,String>(1)?,"sender_id":r.get::<_,String>(2)?,"sender_name":r.get::<_,String>(3)?,"sender_role":r.get::<_,String>(4)?,"text":if deleted {String::new()} else {r.get::<_,String>(5)?},"created_at":r.get::<_,i64>(6)?,"deleted":deleted,"client_message_id":r.get::<_,String>(8)?,"sequence":r.get::<_,i64>(9)?,"attachment":attachment}))
    })
}
pub fn page(c: &Connection, sid: &str, p: &Page) -> Result<Value> {
    let closed: bool = c
        .query_row(
            "SELECT closed_at IS NOT NULL FROM chat_conversations WHERE id=?1",
            [sid],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(Failure::Closed)?;
    if closed {
        return Err(Failure::Closed);
    }
    if p.after.is_some_and(|n| n < 0)
        || p.before.is_some_and(|n| n < 0)
        || (p.after.is_some() && p.before.is_some())
    {
        return Err(Failure::Invalid("Cursor inválido"));
    }
    let mut events = Vec::new();
    let mut messages = Vec::new();
    let mut cursor: i64 = c.query_row(
        "SELECT COALESCE(MAX(sequence),0) FROM chat_events WHERE conversation_id=?1",
        [sid],
        |r| r.get(0),
    )?;
    let has_more;
    let mut next_before = None;
    if let Some(after) = p.after {
        let mut q = c.prepare("SELECT sequence,message_id,kind FROM chat_events WHERE conversation_id=?1 AND sequence>?2 ORDER BY sequence LIMIT 101")?;
        let rows = q
            .query_map(params![sid, after], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        has_more = rows.len() > 100;
        cursor = after;
        for (seq, id, kind) in rows.into_iter().take(100) {
            cursor = seq;
            events.push(json!({"type":kind,"message":message(c,&id)?,"sequence":seq}));
        }
    } else {
        let mut q = c.prepare("SELECT message_id,sequence FROM chat_events WHERE conversation_id=?1 AND kind='chat.message' AND sequence<?2 ORDER BY sequence DESC LIMIT 51")?;
        let rows = q
            .query_map(params![sid, p.before.unwrap_or(i64::MAX)], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        has_more = rows.len() > 50;
        for (id, seq) in rows.into_iter().take(50) {
            next_before = Some(seq);
            messages.push(message(c, &id)?);
        }
        messages.reverse();
    }
    Ok(
        json!({"conversation_id":sid,"messages":messages,"events":events,"cursor":cursor,"has_more":has_more,"next_before":next_before}),
    )
}
pub fn send(
    c: &mut Connection,
    sid: &str,
    sender: &str,
    name: &str,
    role: &str,
    b: &Send,
    now: i64,
) -> Result<Value> {
    let text = b.text.trim();
    if (text.is_empty() && b.attachment_id.is_none())
        || text.chars().count() > 2000
        || text.len() > 8192
        || uuid::Uuid::parse_str(&b.client_message_id).is_err()
    {
        return Err(Failure::Invalid(
            "Escribe hasta 2.000 caracteres o adjunta un archivo, con un identificador de envío válido",
        ));
    }
    let tx = c.transaction()?;
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_conversations WHERE id=?1 AND closed_at IS NULL)",
        [sid],
        |r| r.get(0),
    )?;
    if !active {
        return Err(Failure::Closed);
    }
    let old:Option<String> = tx.query_row("SELECT id FROM chat_messages WHERE conversation_id=?1 AND sender_id=?2 AND client_message_id=?3",params![sid,sender,b.client_message_id],|r|r.get(0)).optional()?;
    if let Some(id) = old {
        return Ok(message(&tx, &id)?);
    }
    let (minute,burst):(i64,i64) = tx.query_row("SELECT COUNT(*),COALESCE(SUM(created_at>?4),0) FROM chat_messages WHERE conversation_id=?1 AND sender_id=?2 AND created_at>?3", params![sid,sender,now-60,now-10],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if minute >= 30 || burst >= 5 {
        return Err(Failure::Limited);
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(file) = &b.attachment_id {
        // Solo un archivo propio, de esta conversación y aún sin enviar.
        let claimed = tx.execute(
            "UPDATE chat_files SET message_id=?1 WHERE id=?2 AND conversation_id=?3 AND uploader_id=?4 AND message_id IS NULL",
            params![id, file, sid, sender],
        )?;
        if claimed == 0 {
            return Err(Failure::Invalid("El archivo adjunto ya no está disponible"));
        }
    }
    tx.execute("INSERT INTO chat_messages(id,conversation_id,sender_id,sender_name,sender_role,text,created_at,client_message_id,attachment_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![id,sid,sender,name,role,text,now,b.client_message_id,b.attachment_id])?;
    tx.execute(
        "INSERT INTO chat_events(conversation_id,message_id,kind) VALUES(?1,?2,'chat.message')",
        params![sid, id],
    )?;
    let result = message(&tx, &id)?;
    tx.commit()?;
    Ok(result)
}
pub fn delete(c: &mut Connection, sid: &str, id: &str) -> Result<Value> {
    let tx = c.transaction()?;
    let changed=tx.execute("UPDATE chat_messages SET deleted=1,text='' WHERE id=?1 AND conversation_id=?2 AND deleted=0",params![id,sid])?;
    let found: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_messages WHERE id=?1 AND conversation_id=?2)",
        params![id, sid],
        |r| r.get(0),
    )?;
    if !found {
        return Err(Failure::Invalid("Mensaje inexistente"));
    }
    if changed > 0 {
        tx.execute(
            "INSERT INTO chat_events(conversation_id,message_id,kind) VALUES(?1,?2,'chat.deleted')",
            params![sid, id],
        )?;
        // Borrar el mensaje borra su archivo; `sweep` lo quita del disco.
        tx.execute("DELETE FROM chat_files WHERE message_id=?1", [id])?;
    }
    let result = message(&tx, id)?;
    tx.commit()?;
    Ok(result)
}
/// Registra un archivo ya guardado en disco. Comprueba la conversación, la
/// frecuencia (10 por minuto y persona) y el total de la conversación.
#[allow(clippy::too_many_arguments)]
pub fn add_file(
    c: &mut Connection,
    sid: &str,
    file: &str,
    uploader: &str,
    name: &str,
    mime: &str,
    size: u64,
    now: i64,
) -> Result<Value> {
    let tx = c.transaction()?;
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_conversations WHERE id=?1 AND closed_at IS NULL)",
        [sid],
        |r| r.get(0),
    )?;
    if !active {
        return Err(Failure::Closed);
    }
    let recent: i64 = tx.query_row(
        "SELECT COUNT(*) FROM chat_files WHERE conversation_id=?1 AND uploader_id=?2 AND created_at>?3",
        params![sid, uploader, now - 60],
        |r| r.get(0),
    )?;
    if recent >= 10 {
        return Err(Failure::Limited);
    }
    let total: i64 = tx.query_row(
        "SELECT COALESCE(SUM(size),0) FROM chat_files WHERE conversation_id=?1",
        [sid],
        |r| r.get(0),
    )?;
    if total + size as i64 > MAX_CONVERSATION_FILES {
        return Err(Failure::Invalid(
            "El chat llegó a 200 MB de archivos: borra alguno para compartir más",
        ));
    }
    tx.execute(
        "INSERT INTO chat_files(id,conversation_id,uploader_id,name,mime,size,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![file, sid, uploader, name, mime, size as i64, now],
    )?;
    tx.commit()?;
    Ok(json!({"id":file,"name":name,"mime":mime,"size":size}))
}
/// Nombre y tipo de un archivo enviado en un mensaje vigente de la conversación activa.
pub fn file(c: &Connection, sid: &str, id: &str) -> Result<(String, String)> {
    c.query_row(
        "SELECT f.name,f.mime FROM chat_files f JOIN chat_messages m ON m.id=f.message_id JOIN chat_conversations v ON v.id=f.conversation_id WHERE f.id=?1 AND f.conversation_id=?2 AND m.deleted=0 AND v.closed_at IS NULL",
        params![id, sid],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or(Failure::Invalid("Archivo no disponible"))
}
/// Quita del disco los archivos que ya no figuran en la base (borrados, caducados
/// o de subidas fallidas). Las subidas en curso (`.part`) se respetan una hora.
pub fn sweep(c: &Connection, dir: &std::path::Path) -> Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    let mut q = c.prepare("SELECT EXISTS(SELECT 1 FROM chat_files WHERE id=?1)")?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let age = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map_or(0, |age| age.as_secs());
        // Un archivo recién guardado aún puede estar registrándose.
        let keep = if name.ends_with(".part") {
            age <= 3600
        } else {
            age < 120 || q.query_row([&name], |r| r.get::<_, bool>(0))?
        };
        if !keep {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        ensure(&c, "a").unwrap();
        ensure(&c, "b").unwrap();
        c
    }
    fn body(text: &str) -> Send {
        Send {
            attachment_id: None,
            session_id: "a".into(),
            client_message_id: uuid::Uuid::new_v4().to_string(),
            text: text.into(),
        }
    }
    #[test]
    fn retries_deletions_cursors_and_isolation() {
        let mut c = setup();
        let b = body("Hola 🐝 <script>texto</script>");
        let first = send(&mut c, "a", "guest", "Ana", "guest", &b, 100).unwrap();
        assert_eq!(
            send(&mut c, "a", "guest", "Ana", "guest", &b, 101).unwrap(),
            first
        );
        assert_eq!(
            page(&c, "b", &Page::default()).unwrap()["messages"],
            json!([])
        );
        let cursor = page(&c, "a", &Page::default()).unwrap()["cursor"]
            .as_i64()
            .unwrap();
        delete(&mut c, "a", first["id"].as_str().unwrap()).unwrap();
        let recovered = page(
            &c,
            "a",
            &Page {
                after: Some(cursor),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(recovered["events"][0]["type"], "chat.deleted");
        assert_eq!(recovered["events"][0]["message"]["text"], "");
        assert_eq!(
            send(&mut c, "a", "guest", "Ana", "guest", &b, 102).unwrap()["deleted"],
            true
        );
        assert!(delete(&mut c, "b", first["id"].as_str().unwrap()).is_err());
    }
    #[test]
    fn pagination_retention_and_validation() {
        let mut c = setup();
        for n in 0..120 {
            send(
                &mut c,
                "a",
                "g",
                "Ana",
                "guest",
                &body(&n.to_string()),
                n * 61,
            )
            .unwrap();
        }
        let last = page(&c, "a", &Page::default()).unwrap();
        assert_eq!(last["messages"].as_array().unwrap().len(), 50);
        assert_eq!(last["has_more"], true);
        let before = last["next_before"].as_i64().unwrap();
        let older = page(
            &c,
            "a",
            &Page {
                before: Some(before),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(older["messages"].as_array().unwrap().len(), 50);
        assert_ne!(last["messages"][0]["id"], older["messages"][0]["id"]);
        let delta = page(
            &c,
            "a",
            &Page {
                after: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(delta["events"].as_array().unwrap().len(), 100);
        assert_eq!(delta["has_more"], true);
        let rest = page(
            &c,
            "a",
            &Page {
                after: delta["cursor"].as_i64(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rest["events"].as_array().unwrap().len(), 20);
        assert!(matches!(
            send(
                &mut c,
                "a",
                "g",
                "Ana",
                "guest",
                &body(&"🐝".repeat(2001)),
                9000
            ),
            Err(Failure::Invalid(_))
        ));
        close(&c, "a", 9000).unwrap();
        assert!(matches!(
            page(&c, "a", &Page::default()),
            Err(Failure::Closed)
        ));
        prune(&c, 9000 + 86399).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            120
        );
        prune(&c, 9000 + 86400).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn rate_limit_and_durable_rotation() {
        let mut c = setup();
        let first = body("primero");
        send(&mut c, "a", "g", "Ana", "guest", &first, 100).unwrap();
        for _ in 0..4 {
            send(&mut c, "a", "g", "Ana", "guest", &body("hola"), 100).unwrap();
        }
        assert!(matches!(
            send(&mut c, "a", "g", "Ana", "guest", &body("sexto"), 100),
            Err(Failure::Limited)
        ));
        assert!(send(&mut c, "a", "g", "Ana", "guest", &first, 100).is_ok());
        assert!(send(&mut c, "a", "g", "Ana", "guest", &body("después"), 111).is_ok());
        let active = local(&c).unwrap();
        assert_eq!(local(&c).unwrap(), active);
        close(&c, &active, 200).unwrap();
        assert_ne!(local(&c).unwrap(), active);
    }
}
