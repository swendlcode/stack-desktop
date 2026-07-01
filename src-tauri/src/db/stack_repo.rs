use std::sync::Arc;

use rusqlite::{params, Row};

use crate::db::DatabasePool;
use crate::error::{Result, StackError};
use crate::models::Stack;

pub struct StackRepository {
    db: Arc<DatabasePool>,
}

impl StackRepository {
    pub fn new(db: Arc<DatabasePool>) -> Self {
        Self { db }
    }

    pub fn list(&self) -> Result<Vec<Stack>> {
        let conn = self.db.get()?;
        let mut stmt = conn.prepare(
            "SELECT s.id, s.name, s.color, s.created_at, \
             (SELECT COUNT(*) FROM stack_assets sa WHERE sa.stack_id = s.id) AS asset_count \
             FROM stacks s ORDER BY s.created_at ASC",
        )?;
        let stacks = stmt
            .query_map([], row_to_stack)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(stacks)
    }

    pub fn create(&self, id: &str, name: &str, now: i64) -> Result<Stack> {
        let conn = self.db.get()?;
        conn.execute(
            "INSERT INTO stacks (id, name, color, created_at) VALUES (?1, ?2, NULL, ?3)",
            params![id, name, now],
        )?;
        Ok(Stack {
            id: id.to_string(),
            name: name.to_string(),
            color: None,
            asset_count: 0,
            created_at: now,
        })
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<()> {
        let conn = self.db.get()?;
        let updated = conn.execute("UPDATE stacks SET name = ?1 WHERE id = ?2", params![name, id])?;
        if updated == 0 {
            return Err(StackError::NotFound(format!("stack {}", id)));
        }
        Ok(())
    }

    pub fn set_color(&self, id: &str, color: &str) -> Result<()> {
        let conn = self.db.get()?;
        let updated = conn.execute("UPDATE stacks SET color = ?1 WHERE id = ?2", params![color, id])?;
        if updated == 0 {
            return Err(StackError::NotFound(format!("stack {}", id)));
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let conn = self.db.get()?;
        conn.execute("DELETE FROM stacks WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn add_asset(&self, stack_id: &str, asset_id: &str, now: i64) -> Result<()> {
        let conn = self.db.get()?;
        let position: i64 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM stack_assets WHERE stack_id = ?1",
            params![stack_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO stack_assets (stack_id, asset_id, position, added_at) \
             VALUES (?1, ?2, ?3, ?4)",
            params![stack_id, asset_id, position, now],
        )?;
        Ok(())
    }

    pub fn remove_asset(&self, stack_id: &str, asset_id: &str) -> Result<()> {
        let conn = self.db.get()?;
        conn.execute(
            "DELETE FROM stack_assets WHERE stack_id = ?1 AND asset_id = ?2",
            params![stack_id, asset_id],
        )?;
        Ok(())
    }
}

fn row_to_stack(row: &Row) -> rusqlite::Result<Stack> {
    Ok(Stack {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        created_at: row.get(3)?,
        asset_count: row.get(4)?,
    })
}
