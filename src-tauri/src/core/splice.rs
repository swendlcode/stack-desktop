//! Finding an existing Splice library on disk.
//!
//! Splice nests its packs at `<root>/sounds/packs/<Pack Name>/…`. Stack's pack
//! detection takes the folder one level below the watched root, so watching
//! `<root>` itself collapses every pack the user owns into a single pack named
//! "sounds". The inner `sounds/packs` directories are therefore what we
//! register, not the Splice root.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One registerable directory inside a Splice library.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpliceRoot {
    /// Directory to watch — always a `…/sounds/packs`.
    pub path: String,
    /// Account folder this came from, when it is not the main library.
    pub account: Option<String>,
    pub pack_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpliceLibrary {
    /// The Splice folder itself, for display.
    pub root: String,
    pub roots: Vec<SpliceRoot>,
    pub total_packs: usize,
}

/// Directories that look like a Splice library but must never be indexed.
/// `backup/` mirrors the whole tree.
const EXCLUDED: &[&str] = &["backup", "backups"];

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Splice's own record of where the user pointed it.
///
/// It is an Electron app, so settings live under the per-user data dir. The
/// value goes stale — on a real machine three of four profiles pointed at
/// directories that no longer existed — so every hit is stat'd by the caller.
fn configured_paths() -> Vec<PathBuf> {
    let Some(home) = home() else {
        return Vec::new();
    };

    #[cfg(target_os = "macos")]
    let base = home.join("Library/Application Support/com.splice.Splice/users/default");
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Roaming"))
        .join("com.splice.Splice/users/default");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = home.join(".config/com.splice.Splice/users/default");

    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(&base) else {
        return found;
    };
    for entry in entries.flatten() {
        let settings = entry.path().join("settings.json");
        let Ok(raw) = std::fs::read_to_string(&settings) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if let Some(folder) = json.get("splice_folder").and_then(|v| v.as_str()) {
            if !folder.trim().is_empty() {
                found.push(PathBuf::from(folder));
            }
        }
    }
    found
}

/// Where Splice puts the folder when the user never moved it.
fn conventional_paths() -> Vec<PathBuf> {
    let Some(home) = home() else {
        return Vec::new();
    };
    let mut paths = vec![
        home.join("Splice"),
        home.join("Documents/Splice"),
        home.join("Music/Splice"),
    ];
    if cfg!(target_os = "windows") {
        // Splice's own docs still name this one.
        paths.push(PathBuf::from(r"C:\Documents\Splice"));
    }
    paths
}

/// A directory is a Splice library if it carries the marker or the layout.
fn is_splice_library(dir: &Path) -> bool {
    dir.is_dir() && (dir.join(".splice").exists() || dir.join("sounds/packs").is_dir())
}

fn count_packs(packs_dir: &Path) -> usize {
    std::fs::read_dir(packs_dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| {
                    e.file_type().map(|t| t.is_dir()).unwrap_or(false)
                        && !e.file_name().to_string_lossy().starts_with('.')
                })
                .count()
        })
        .unwrap_or(0)
}

/// Collect the `sounds/packs` directories worth watching: the library's own,
/// plus one per additional account folder that actually holds packs.
fn inner_roots(root: &Path) -> Vec<SpliceRoot> {
    let mut roots = Vec::new();

    let main = root.join("sounds/packs");
    if main.is_dir() {
        let pack_count = count_packs(&main);
        if pack_count > 0 {
            roots.push(SpliceRoot {
                path: main.to_string_lossy().into_owned(),
                account: None,
                pack_count,
            });
        }
    }

    // Extra accounts land in `Splice - user-<id>/` beside the main tree.
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !path.is_dir()
                || name.starts_with('.')
                || EXCLUDED.iter().any(|e| e.eq_ignore_ascii_case(name))
            {
                continue;
            }
            let packs = path.join("sounds/packs");
            if !packs.is_dir() {
                continue;
            }
            let pack_count = count_packs(&packs);
            // An account the user never downloaded into is noise.
            if pack_count == 0 {
                continue;
            }
            roots.push(SpliceRoot {
                path: packs.to_string_lossy().into_owned(),
                account: Some(name.to_string()),
                pack_count,
            });
        }
    }

    roots.sort_by(|a, b| b.pack_count.cmp(&a.pack_count));
    roots
}

/// Best Splice library on this machine, if there is one.
pub fn detect() -> Option<SpliceLibrary> {
    let mut candidates: Vec<PathBuf> = configured_paths();
    candidates.extend(conventional_paths());

    let mut seen: Vec<PathBuf> = Vec::new();
    let mut best: Option<SpliceLibrary> = None;

    for candidate in candidates {
        let resolved = std::fs::canonicalize(&candidate).unwrap_or(candidate);
        if seen.contains(&resolved) || !is_splice_library(&resolved) {
            continue;
        }
        seen.push(resolved.clone());

        let roots = inner_roots(&resolved);
        if roots.is_empty() {
            continue;
        }
        let total_packs = roots.iter().map(|r| r.pack_count).sum();
        let library = SpliceLibrary {
            root: resolved.to_string_lossy().into_owned(),
            roots,
            total_packs,
        };
        // Prefer whichever library actually holds the most packs.
        if best.as_ref().map(|b| total_packs > b.total_packs).unwrap_or(true) {
            best = Some(library);
        }
    }

    best
}
