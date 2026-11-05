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
    pub text: String,
}
pub fn init(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS chat_conversations(id TEXT PRIMARY KEY, closed_at INTEGER);
      CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, sender_role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, client_message_id TEXT NOT NULL, UNIQUE(conversation_id,sender_id,client_message_id));
      CREATE TABLE IF NOT EXISTS chat_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, kind TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_event_cursor ON chat_events(conversation_id,sequence);
      CREATE INDEX IF NOT EXISTS chat_message_rate ON chat_messages(conversation_id,sender_id,created_at);")
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
    c.execute(
        "DELETE FROM chat_conversations WHERE closed_at <= ?1",
        [now - 86400],
    )?;
    Ok(())
}
fn message(c: &Connection, id: &str) -> rusqlite::Result<Value> {
    c.query_row("SELECT m.id,m.conversation_id,m.sender_id,m.sender_name,m.sender_role,m.text,m.created_at,m.deleted,m.client_message_id,(SELECT MIN(sequence) FROM chat_events WHERE message_id=m.id) FROM chat_messages m WHERE m.id=?1",[id],|r| {
        let deleted = r.get::<_,bool>(7)?;
        Ok(json!({"id":r.get::<_,String>(0)?,"conversation_id":r.get::<_,String>(1)?,"sender_id":r.get::<_,String>(2)?,"sender_name":r.get::<_,String>(3)?,"sender_role":r.get::<_,String>(4)?,"text":if deleted {String::new()} else {r.get::<_,String>(5)?},"created_at":r.get::<_,i64>(6)?,"deleted":deleted,"client_message_id":r.get::<_,String>(8)?,"sequence":r.get::<_,i64>(9)?}))
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
    if text.is_empty()
        || text.chars().count() > 2000
        || text.len() > 8192
        || uuid::Uuid::parse_str(&b.client_message_id).is_err()
    {
        return Err(Failure::Invalid(
            "Escribe entre 1 y 2.000 caracteres y usa un identificador de envío válido",
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
    tx.execute("INSERT INTO chat_messages(id,conversation_id,sender_id,sender_name,sender_role,text,created_at,client_message_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![id,sid,sender,name,role,text,now,b.client_message_id])?;
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
    }
    let result = message(&tx, id)?;
    tx.commit()?;
    Ok(result)
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
