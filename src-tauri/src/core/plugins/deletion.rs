//! Permanent plugin deletion. Every path is re-validated against a whitelist
//! of known plugin/leftover roots before anything is touched, unprivileged
//! removal is tried first, and everything that needs admin rights is batched
//! into a single elevation prompt.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use crate::error::{Result, StackError};
use crate::models::{DeleteFailure, DeleteReport};

use super::{elevation, leftovers, metadata, scanner};

pub enum ElevationOutcome {
    Success,
    Cancelled,
    Failed(String),
}

pub fn delete(
    paths: Vec<String>,
    registry_keys: Vec<String>,
    extra_roots: Vec<String>,
) -> Result<DeleteReport> {
    let whitelist = whitelist_roots(&extra_roots);
    for p in &paths {
        validate_path(p, &whitelist)?;
    }
    for k in &registry_keys {
        validate_registry_key(k)?;
    }
    let paths = prune_nested(paths);

    let sizes: HashMap<String, u64> = paths
        .iter()
        .map(|p| (p.clone(), metadata::total_size(Path::new(p))))
        .collect();

    let mut errors: HashMap<String, String> = HashMap::new();
    let mut privileged: Vec<String> = Vec::new();

    for p in &paths {
        match try_remove(Path::new(p)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                privileged.push(p.clone());
            }
            Err(e) => {
                errors.insert(p.clone(), e.to_string());
            }
        }
    }

    // Registry: HKCU needs no elevation; HKLM rides along with the elevated batch.
    let (hklm_keys, hkcu_keys): (Vec<String>, Vec<String>) = registry_keys
        .iter()
        .cloned()
        .partition(|k| k.starts_with("HKLM"));
    for key in &hkcu_keys {
        if let Err(e) = delete_hkcu_key(key) {
            errors.insert(key.clone(), e);
        }
    }

    let mut elevation_used = false;
    let mut elevation_cancelled = false;
    if !privileged.is_empty() || !hklm_keys.is_empty() {
        elevation_used = true;
        match elevation::delete_elevated(&privileged, &hklm_keys) {
            ElevationOutcome::Success => {}
            ElevationOutcome::Cancelled => elevation_cancelled = true,
            ElevationOutcome::Failed(msg) => {
                for p in privileged.iter().chain(hklm_keys.iter()) {
                    errors.entry(p.clone()).or_insert_with(|| msg.clone());
                }
            }
        }
    }

    // Elevated rm/reg give no per-item feedback — verify by absence.
    let mut deleted: Vec<String> = Vec::new();
    let mut failed: Vec<DeleteFailure> = Vec::new();
    let mut bytes_freed: u64 = 0;
    for p in &paths {
        if Path::new(p).symlink_metadata().is_err() {
            bytes_freed += sizes.get(p).copied().unwrap_or(0);
            deleted.push(p.clone());
        } else {
            let error = errors
                .get(p)
                .cloned()
                .unwrap_or_else(|| default_failure_reason(elevation_cancelled));
            failed.push(DeleteFailure { path: p.clone(), error });
        }
    }
    for key in registry_keys {
        if registry_key_exists(&key) {
            let error = errors
                .get(&key)
                .cloned()
                .unwrap_or_else(|| default_failure_reason(elevation_cancelled));
            failed.push(DeleteFailure { path: key, error });
        } else {
            deleted.push(key);
        }
    }

    #[cfg(target_os = "macos")]
    if deleted.iter().any(|p| p.ends_with(".component")) {
        // Force the AU registrar to drop its cache of the removed component.
        let _ = std::process::Command::new("killall")
            .args(["-9", "AudioComponentRegistrar"])
            .output();
    }

    Ok(DeleteReport {
        deleted,
        failed,
        bytes_freed,
        elevation_used,
        elevation_cancelled,
    })
}

fn default_failure_reason(elevation_cancelled: bool) -> String {
    if elevation_cancelled {
        "administrator authorization was cancelled".to_string()
    } else {
        "still present after deletion attempt".to_string()
    }
}

fn whitelist_roots(extra_roots: &[String]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = scanner::default_roots().into_iter().map(|r| r.path).collect();
    roots.extend(leftovers::sweep_root_paths());
    roots.extend(extra_roots.iter().map(PathBuf::from));
    roots
}

fn validate_path(path: &str, whitelist: &[PathBuf]) -> Result<()> {
    let p = Path::new(path);
    let component_count = p.components().count();
    let is_valid = p.is_absolute()
        && component_count >= 4 // e.g. RootDir + Library + Audio + name
        && !p.components().any(|c| matches!(c, Component::ParentDir))
        && whitelist
            .iter()
            .any(|root| p.starts_with(root) && p != root.as_path());
    if is_valid {
        Ok(())
    } else {
        Err(StackError::Other(format!(
            "refusing to delete path outside known plugin locations: {path}"
        )))
    }
}

fn validate_registry_key(key: &str) -> Result<()> {
    let valid_base = key.starts_with("HKCU\\Software\\") || key.starts_with("HKLM\\SOFTWARE\\");
    if valid_base && key.split('\\').count() >= 3 && !key.contains('"') {
        Ok(())
    } else {
        Err(StackError::Other(format!(
            "refusing to delete registry key outside Software hives: {key}"
        )))
    }
}

/// Drop any path that is a descendant of another selected path — deleting the
/// ancestor covers it, and attempting both would misreport the child as failed.
fn prune_nested(mut paths: Vec<String>) -> Vec<String> {
    paths.sort();
    paths.dedup();
    let all = paths.clone();
    paths.retain(|p| {
        !all.iter()
            .any(|other| other != p && Path::new(p).starts_with(other))
    });
    paths
}

fn try_remove(path: &Path) -> std::io::Result<()> {
    let meta = path.symlink_metadata()?;
    if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        // Files and symlinks alike — never follow a link to its target.
        std::fs::remove_file(path)
    }
}

#[cfg(target_os = "windows")]
fn delete_hkcu_key(key: &str) -> std::result::Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let sub = key
        .strip_prefix("HKCU\\")
        .ok_or_else(|| "not an HKCU key".to_string())?;
    RegKey::predef(HKEY_CURRENT_USER)
        .delete_subkey_all(sub)
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
fn delete_hkcu_key(_key: &str) -> std::result::Result<(), String> {
    Err("registry keys only exist on Windows".to_string())
}

#[cfg(target_os = "windows")]
fn registry_key_exists(key: &str) -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let (hive, sub) = if let Some(s) = key.strip_prefix("HKCU\\") {
        (RegKey::predef(HKEY_CURRENT_USER), s)
    } else if let Some(s) = key.strip_prefix("HKLM\\") {
        (RegKey::predef(HKEY_LOCAL_MACHINE), s)
    } else {
        return false;
    };
    hive.open_subkey(sub).is_ok()
}

#[cfg(not(target_os = "windows"))]
fn registry_key_exists(_key: &str) -> bool {
    false
}
