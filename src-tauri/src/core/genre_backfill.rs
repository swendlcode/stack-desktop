//! One-time repair pass for migration 010.
//!
//! `genre` was detected from the path since the first release but never
//! stored, and the same migration rebuilds `assets_fts` with two extra
//! columns — which leaves it empty. Rather than force a full re-index (which
//! re-reads every file on disk), both are rebuilt here from data already in
//! the database: genre is derived from each asset's path, and the FTS rows
//! are re-inserted from the `assets` table. Runs in the background on
//! startup and is a no-op once the index is populated.

use std::sync::Arc;

use crate::db::DatabasePool;
use crate::error::Result;
use crate::metadata::path_parser;

const BATCH: usize = 2_000;

/// True when the FTS index is empty while assets exist — i.e. migration 010
/// has just run and the index has not been rebuilt yet.
pub fn needs_rebuild(pool: &Arc<DatabasePool>) -> Result<bool> {
    let conn = pool.get()?;
    let assets: i64 = conn.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))?;
    if assets == 0 {
        return Ok(false);
    }
    let indexed: i64 = conn.query_row("SELECT COUNT(*) FROM assets_fts", [], |r| r.get(0))?;
    Ok(indexed == 0)
}

pub fn run(pool: &Arc<DatabasePool>) -> Result<usize> {
    let rows: Vec<(String, String, Option<String>)> = {
        let conn = pool.get()?;
        let mut stmt = conn.prepare(
            "SELECT a.id, a.path, p.root_path FROM assets a \
             LEFT JOIN packs p ON p.id = a.pack_id \
             WHERE a.index_status != 'missing'",
        )?;
        let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2).ok())))?;
        mapped.collect::<std::result::Result<Vec<_>, _>>()?
    };

    let mut updated = 0usize;
    for chunk in rows.chunks(BATCH) {
        let mut conn = pool.get()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        {
            let mut stmt = tx.prepare_cached("UPDATE assets SET genre = ?1 WHERE id = ?2")?;
            for (id, path, root) in chunk {
                // Match only below the pack root so directories above the
                // library (usernames, volume names) can't fabricate a genre.
                let relative = match root {
                    Some(r) if path.len() > r.len() && path.starts_with(r.as_str()) => &path[r.len()..],
                    _ => path.as_str(),
                };
                if let Some(genre) = path_parser::genre_from_text(&relative.to_lowercase()) {
                    stmt.execute(rusqlite::params![genre, id])?;
                    updated += 1;
                }
            }
        }
        tx.commit()?;
    }

    // Repopulate the search index from the rebuilt rows.
    {
        let conn = pool.get()?;
        conn.execute_batch(
            "INSERT INTO assets_fts (id, filename, pack_name, instrument, user_tags, subtype, genre) \
             SELECT id, filename, COALESCE(pack_name, ''), COALESCE(instrument, ''), \
                    COALESCE(user_tags, ''), COALESCE(subtype, ''), COALESCE(genre, '') \
             FROM assets WHERE index_status != 'missing';",
        )?;
    }

    crate::search::suggestions::invalidate_popular();
    tracing::info!("genre backfill: tagged {} assets, rebuilt search index", updated);
    Ok(updated)
}
