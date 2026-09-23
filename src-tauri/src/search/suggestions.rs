//! Search suggestions: autocomplete, typo correction and popular terms.
//!
//! All three read `assets_vocab`, the fts5vocab view over the search index,
//! so the vocabulary is always exactly the words in the user's own library —
//! no curated word list to drift out of date.

use crate::db::DatabasePool;
use crate::error::Result;
use crate::models::SearchSuggestions;

use super::FuzzyMatcher;

/// Tokens that are in every filename and carry no meaning as a search.
const STOPWORDS: &[&str] = &[
    "wav", "mp3", "aiff", "aif", "flac", "ogg", "mid", "midi", "fxp", "nmsv",
    "the", "and", "vol", "bpm", "loop", "sample", "samples", "pack",
];

fn is_useful(term: &str) -> bool {
    term.chars().count() >= 3
        && !term.chars().all(|c| c.is_ascii_digit())
        && !STOPWORDS.contains(&term)
}

/// `assets_vocab` has no index, so ordering it by frequency scans every term
/// in the library (~90ms at 164k assets). The result only changes when the
/// index is rebuilt, and it is only shown on an empty box, so compute it once.
static POPULAR: std::sync::Mutex<Option<Vec<String>>> = std::sync::Mutex::new(None);

/// Drop the cached popular terms after the index changes.
pub fn invalidate_popular() {
    if let Ok(mut cached) = POPULAR.lock() {
        *cached = None;
    }
}

fn popular_terms(conn: &rusqlite::Connection, limit: usize) -> Result<Vec<String>> {
    if let Ok(cached) = POPULAR.lock() {
        if let Some(terms) = cached.as_ref() {
            return Ok(terms.iter().take(limit).cloned().collect());
        }
    }

    let mut terms: Vec<String> = Vec::new();
    {
        let mut stmt =
            conn.prepare_cached("SELECT term FROM assets_vocab ORDER BY doc DESC LIMIT 400")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for term in rows.flatten() {
            if is_useful(&term) {
                terms.push(term);
            }
            if terms.len() >= 40 {
                break;
            }
        }
    }

    if let Ok(mut cached) = POPULAR.lock() {
        *cached = Some(terms.clone());
    }
    Ok(terms.into_iter().take(limit).collect())
}

pub fn suggest(pool: &DatabasePool, query: &str, limit: usize) -> Result<SearchSuggestions> {
    let conn = pool.get()?;
    let trimmed = query.trim().to_lowercase();

    // Only the empty box shows the popular chips; typing must not pay for them.
    if trimmed.is_empty() {
        return Ok(SearchSuggestions {
            completions: Vec::new(),
            corrections: Vec::new(),
            popular: popular_terms(&conn, limit)?,
        });
    }
    let popular: Vec<String> = Vec::new();

    // Autocomplete: last word of the query, most common matches first.
    let last = trimmed.split_whitespace().last().unwrap_or("").to_string();
    let mut completions: Vec<String> = Vec::new();
    if last.chars().count() >= 2 {
        let pattern = format!("{}*", last.replace(['*', '?', '['], ""));
        let mut stmt = conn.prepare_cached(
            "SELECT term FROM assets_vocab WHERE term GLOB ?1 ORDER BY doc DESC LIMIT 40",
        )?;
        let rows = stmt.query_map([&pattern], |r| r.get::<_, String>(0))?;
        for term in rows.flatten() {
            if term != last && is_useful(&term) {
                completions.push(term);
            }
            if completions.len() >= limit {
                break;
            }
        }
    }

    // "Did you mean": only worth computing when the term itself is rare or
    // absent, and only against terms of a similar length and shape so the
    // edit-distance pass stays bounded regardless of library size.
    let mut corrections: Vec<String> = Vec::new();
    let exact_docs: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(doc), 0) FROM assets_vocab WHERE term = ?1",
            [&last],
            |r| r.get(0),
        )
        .unwrap_or(0);

    if exact_docs == 0 && completions.is_empty() && last.chars().count() >= 3 {
        let len = last.chars().count() as i64;
        let first = last.chars().next().unwrap_or('a').to_string();
        let mut stmt = conn.prepare_cached(
            "SELECT term FROM assets_vocab \
             WHERE LENGTH(term) BETWEEN ?1 AND ?2 AND (term GLOB ?3 OR term GLOB ?4) \
             ORDER BY doc DESC LIMIT 600",
        )?;
        let any_first = format!("?{}*", last.chars().nth(1).unwrap_or('a'));
        let rows = stmt.query_map(
            rusqlite::params![len - 2, len + 2, format!("{}*", first), any_first],
            |r| r.get::<_, String>(0),
        )?;

        let mut matcher = FuzzyMatcher::new();
        let mut scored: Vec<(f32, String)> = Vec::new();
        for term in rows.flatten() {
            if !is_useful(&term) {
                continue;
            }
            let score = matcher.similarity(&last, &term);
            if score > 0.72 {
                scored.push((score, term));
            }
        }
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.dedup_by(|a, b| a.1 == b.1);
        corrections = scored.into_iter().take(3).map(|(_, t)| t).collect();
    }

    Ok(SearchSuggestions {
        completions,
        corrections,
        popular,
    })
}
