use crate::model::Data;
use rusqlite::{Connection, params};
pub struct Store {
    conn: Connection,
    /// Último JSON escrito: evita fsync cuando una mutación no cambia nada.
    last: std::cell::RefCell<Option<String>>,
}
impl Store {
    pub fn open(path: &str) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
        Ok(Self {
            conn,
            last: Default::default(),
        })
    }
    pub fn load(&self) -> anyhow::Result<Data> {
        let mut q = self.conn.prepare("SELECT json FROM state WHERE id=1")?;
        let mut rows = q.query([])?;
        Ok(if let Some(row) = rows.next()? {
            let json: String = row.get(0)?;
            let data = serde_json::from_str(&json)?;
            *self.last.borrow_mut() = Some(json);
            data
        } else {
            Data::default()
        })
    }
    pub fn save(&self, data: &Data) -> anyhow::Result<()> {
        let json = serde_json::to_string(data)?;
        if self.last.borrow().as_deref() == Some(json.as_str()) {
            return Ok(());
        }
        self.conn.execute("INSERT INTO state(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json",params![json])?;
        *self.last.borrow_mut() = Some(json);
        Ok(())
    }
    pub fn setting(&self, key: &str) -> anyhow::Result<Option<String>> {
        use rusqlite::OptionalExtension;
        Ok(self
            .conn
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }
    pub fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value])?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unchanged_state_is_not_rewritten_and_changes_round_trip() {
        let store = Store::open(":memory:").unwrap();
        let mut data = Data::default();
        store.save(&data).unwrap();
        // Corrompemos la fila a mano: si save() no reescribe, sigue corrupta.
        store
            .conn
            .execute("UPDATE state SET json='{}'", [])
            .unwrap();
        store.save(&data).unwrap();
        let raw: String = store
            .conn
            .query_row("SELECT json FROM state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(raw, "{}");
        data.program.revision += 1;
        store.save(&data).unwrap();
        assert_eq!(
            store.load().unwrap().program.revision,
            data.program.revision
        );
    }
}
