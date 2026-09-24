//! One-time repair for the cover propagation bug.
//!
//! Setting a pack cover used to copy the image into every descendant folder's
//! `.stack/` and stamp each folder's macOS Finder icon. On a real project that
//! turned one 2.2MB image into 27 copies (61MB) and rebranded 64 folders the
//! user never asked to change. Covers are now inherited upward at read time
//! instead, and this pass removes what the old behaviour left behind.
//!
//! Deliberately conservative: a descendant cover is only removed when it is
//! byte-identical to an ancestor's, so artwork a user set on a subfolder
//! themselves is never touched.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use xxhash_rust::xxh3::xxh3_64;

use crate::db::DatabasePool;
use crate::error::Result;

const ARTWORK_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp"];
const MARKER: &str = "artwork-cleanup-v1.done";

#[derive(Debug, Default)]
pub struct CleanupReport {
    pub copies_removed: usize,
    pub bytes_freed: u64,
    pub icons_reset: usize,
}

pub fn needs_cleanup(app_data: &Path) -> bool {
    !app_data.join(MARKER).exists()
}

fn mark_done(app_data: &Path) {
    let _ = std::fs::write(app_data.join(MARKER), b"");
}

fn cover_in(dir: &Path) -> Option<PathBuf> {
    let stack = dir.join(".stack");
    ARTWORK_EXTS
        .iter()
        .map(|e| stack.join(format!("cover.{e}")))
        .find(|p| p.exists())
}

/// Depth-first walk carrying the nearest ancestor cover's fingerprint down.
fn visit(
    dir: &Path,
    ancestor: Option<(u64, u64)>, // (len, hash)
    report: &mut CleanupReport,
    reset_icons: &mut Vec<PathBuf>,
) {
    let mut inherited = ancestor;

    if let Some(cover) = cover_in(dir) {
        if let Ok(bytes) = std::fs::read(&cover) {
            let fingerprint = (bytes.len() as u64, xxh3_64(&bytes));
            match ancestor {
                // Same image as an ancestor: this is a propagated copy.
                Some(a) if a == fingerprint => {
                    if std::fs::remove_file(&cover).is_ok() {
                        report.copies_removed += 1;
                        report.bytes_freed += fingerprint.0;
                        if dir.join("Icon\r").exists() {
                            reset_icons.push(dir.to_path_buf());
                        }
                        // Drop the stale export alongside it.
                        let _ = std::fs::remove_file(dir.join(".stack/finder-icon.png"));
                    }
                }
                // Different image: the user's own choice — keep it, and it
                // becomes the reference for everything below.
                _ => inherited = Some(fingerprint),
            }
        }
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        visit(&path, inherited, report, reset_icons);
    }
}

pub fn run(pool: &DatabasePool, app_data: &Path) -> Result<CleanupReport> {
    let roots: Vec<String> = {
        let conn = pool.get()?;
        let mut stmt = conn.prepare("SELECT path FROM watched_folders")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.flatten().collect()
    };

    let mut report = CleanupReport::default();
    let mut reset_icons: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();

    for root in roots {
        let path = PathBuf::from(&root);
        if !path.is_dir() || !seen.insert(path.clone()) {
            continue;
        }
        // The root's own cover is the user's — seed the walk from its children
        // so it is never a removal candidate.
        let ancestor = cover_in(&path).and_then(|c| {
            std::fs::read(&c).ok().map(|b| (b.len() as u64, xxh3_64(&b)))
        });
        if let Ok(entries) = std::fs::read_dir(&path) {
            for entry in entries.flatten() {
                let child = entry.path();
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
                    && !child
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with('.'))
                        .unwrap_or(true)
                {
                    visit(&child, ancestor, &mut report, &mut reset_icons);
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        report.icons_reset = reset_folder_icons(&reset_icons);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &reset_icons;
    }

    mark_done(app_data);
    tracing::info!(
        "artwork cleanup: removed {} duplicate covers ({} MB), reset {} folder icons",
        report.copies_removed,
        report.bytes_freed / 1_048_576,
        report.icons_reset
    );
    Ok(report)
}

/// Clear custom Finder icons in one osascript call — a separate process per
/// folder would take ~0.3s each, which is minutes across a large library.
#[cfg(target_os = "macos")]
fn reset_folder_icons(folders: &[PathBuf]) -> usize {
    if folders.is_empty() {
        return 0;
    }
    let script = r#"
ObjC.import('AppKit');
function run(argv) {
  var n = 0;
  for (var i = 0; i < argv.length; i++) {
    if ($.NSWorkspace.sharedWorkspace.setIconForFileOptions($(), argv[i], 0)) n++;
  }
  return String(n);
}
"#;
    let mut cmd = std::process::Command::new("osascript");
    cmd.arg("-l").arg("JavaScript").arg("-e").arg(script);
    for f in folders {
        cmd.arg(f.as_os_str());
    }
    match cmd.output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or(0),
        Err(e) => {
            tracing::warn!("artwork cleanup: icon reset failed: {}", e);
            0
        }
    }
}
