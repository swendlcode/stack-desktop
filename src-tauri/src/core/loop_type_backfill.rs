//! One-time repair pass for migration 013.
//!
//! Two fixes from github issue #11, both derived from data already in the
//! database so nothing on disk is re-read:
//!
//! 1. `loop_type` is filled in for every sample. It used to be one value
//!    among many in `subtype`, decided first-match-wins, so a file called
//!    `KICK_loop_128.wav` resolved to "kick" and the loop signal was lost —
//!    only 17% of a 90k-sample library carried the distinction, which made
//!    the One-Shots & Loops filter look broken.
//! 2. `instrument` values that name a packaging folder rather than an
//!    instrument (`loop`, `one_shot`, `midi`, `preset`) are cleared. They came
//!    from `path_parser`'s category map and showed up in the Instruments
//!    filter as an entry called "one-shots".

use std::path::Path;
use std::sync::Arc;

use crate::db::DatabasePool;
use crate::error::Result;
use crate::metadata::loop_type;

const BATCH: usize = 2_000;

/// Folder names that were being stored as instruments.
const NOT_INSTRUMENTS: &[&str] = &["loop", "one_shot", "oneshot", "midi", "preset"];

/// True while any live sample still has no `loop_type`.
pub fn needs_backfill(pool: &Arc<DatabasePool>) -> Result<bool> {
    let conn = pool.get()?;
    let pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM assets \
         WHERE type = 'sample' AND index_status != 'missing' AND loop_type IS NULL",
        [],
        |r| r.get(0),
    )?;
    Ok(pending > 0)
}

pub fn run(pool: &Arc<DatabasePool>) -> Result<usize> {
    // Clear the four non-instruments first — one statement, no scan per row.
    {
        let conn = pool.get()?;
        let placeholders = vec!["?"; NOT_INSTRUMENTS.len()].join(",");
        let cleared = conn.execute(
            &format!(
                "UPDATE assets SET instrument = NULL WHERE instrument IN ({})",
                placeholders
            ),
            rusqlite::params_from_iter(NOT_INSTRUMENTS.iter()),
        )?;
        if cleared > 0 {
            tracing::info!("loop_type backfill: cleared {} non-instrument values", cleared);
        }
    }

    let rows: Vec<(String, String, Option<f32>, Option<i64>)> = {
        let conn = pool.get()?;
        let mut stmt = conn.prepare(
            "SELECT id, path, bpm, duration_ms FROM assets \
             WHERE type = 'sample' AND index_status != 'missing' AND loop_type IS NULL",
        )?;
        let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2).ok(), r.get(3).ok())))?;
        mapped.collect::<std::result::Result<Vec<_>, _>>()?
    };

    let mut updated = 0usize;
    for chunk in rows.chunks(BATCH) {
        let mut conn = pool.get()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        {
            let mut stmt = tx.prepare_cached("UPDATE assets SET loop_type = ?1 WHERE id = ?2")?;
            for (id, path, bpm, duration_ms) in chunk {
                let p = Path::new(path);
                let filename = p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                // Nearest folders first: a kit under `.../Loops/EDM/drum hits/`
                // is one-shots, and the closest folder is the one that knows.
                let parents: Vec<String> = p
                    .parent()
                    .map(|d| {
                        d.components()
                            .rev()
                            .take(4)
                            .map(|c| c.as_os_str().to_string_lossy().to_string())
                            .collect()
                    })
                    .unwrap_or_default();

                if let Some(t) = loop_type::classify(&filename, &parents, *bpm, *duration_ms) {
                    stmt.execute(rusqlite::params![t.as_str(), id])?;
                    updated += 1;
                }
            }
        }
        tx.commit()?;
    }

    tracing::info!("loop_type backfill: classified {} samples", updated);
    Ok(updated)
}
