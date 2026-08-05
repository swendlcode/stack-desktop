//! Leftover discovery for plugin removal: sibling format copies, vendor data,
//! presets, prefs, caches — matched conservatively (exact normalized names,
//! AppCleaner-style) so a wrong match can never reach the delete list.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::error::{Result, StackError};
use crate::models::{LeftoverItem, LeftoverReport, PluginEntry};

use super::metadata;
use super::scanner::{self, normalize_name};

struct SweepRoot {
    path: PathBuf,
    category: &'static str,
}

pub fn find(plugin_path: &str, extra_paths: &[String]) -> Result<LeftoverReport> {
    let all = scanner::scan(&[], extra_paths);
    let target = all
        .iter()
        .find(|e| e.path == plugin_path)
        .cloned()
        .or_else(|| synthesize_entry(plugin_path))
        .ok_or_else(|| StackError::NotFound(format!("plugin not found: {plugin_path}")))?;

    let plugin_norm = normalize_name(&target.name);
    let vendor_norm = target.vendor.as_deref().map(normalize_vendor);
    // Vendor locations are "shared" when other installed plugins claim the same vendor.
    let vendor_shared = match &vendor_norm {
        Some(vn) => all.iter().any(|e| {
            normalize_name(&e.name) != plugin_norm
                && e.vendor.as_deref().map(normalize_vendor).as_ref() == Some(vn)
        }),
        None => false,
    };

    let mut items: Vec<LeftoverItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut push = |items: &mut Vec<LeftoverItem>, path: String, category: &str, confidence: &str, shared: bool, is_registry_key: bool| {
        if seen.insert(path.clone()) {
            let size_bytes = if is_registry_key {
                0
            } else {
                metadata::total_size(Path::new(&path))
            };
            items.push(LeftoverItem {
                path,
                size_bytes,
                category: category.to_string(),
                confidence: confidence.to_string(),
                shared,
                is_registry_key,
            });
        }
    };

    push(&mut items, target.path.clone(), "binary", "exact", false, false);
    for sib in &target.siblings {
        push(&mut items, sib.path.clone(), "sibling", "exact", false, false);
    }

    for root in sweep_roots() {
        if !root.path.is_dir() {
            continue;
        }
        for child in std::fs::read_dir(&root.path).into_iter().flatten().flatten() {
            let child_path = child.path();
            let Some(file_name) = child_path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let stem_norm = normalize_name(
                child_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(file_name),
            );

            // Bundle-id named files/dirs (prefs plists, saved state) — strongest signal.
            if let Some(id) = &target.bundle_id {
                if file_name.to_lowercase().starts_with(&id.to_lowercase()) {
                    push(&mut items, child_path.to_string_lossy().into_owned(), root.category, "exact", false, false);
                    continue;
                }
            }
            if stem_norm == plugin_norm && !stem_norm.is_empty() {
                push(&mut items, child_path.to_string_lossy().into_owned(), root.category, "high", false, false);
                continue;
            }
            if let Some(vn) = &vendor_norm {
                if vendor_matches(&stem_norm, vn) && child_path.is_dir() {
                    // A plugin-named subdir inside the vendor dir is deletable with
                    // confidence even when the vendor dir itself is shared.
                    let mut found_subdir = false;
                    for sub in std::fs::read_dir(&child_path).into_iter().flatten().flatten() {
                        let sub_path = sub.path();
                        let sub_norm = normalize_name(
                            sub_path.file_stem().and_then(|s| s.to_str()).unwrap_or(""),
                        );
                        if sub_norm == plugin_norm && !sub_norm.is_empty() {
                            push(&mut items, sub_path.to_string_lossy().into_owned(), root.category, "high", false, false);
                            found_subdir = true;
                        }
                    }
                    let shared = vendor_shared || found_subdir;
                    push(&mut items, child_path.to_string_lossy().into_owned(), root.category, "vendor", shared, false);
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    sweep_registry(&target, &plugin_norm, vendor_norm.as_deref(), vendor_shared, &mut seen, &mut items);

    let total_size_bytes = items.iter().map(|i| i.size_bytes).sum();
    let needs_elevation = items.iter().any(|i| requires_elevation(i));

    Ok(LeftoverReport {
        plugin_name: target.name,
        vendor: target.vendor,
        bundle_id: target.bundle_id,
        items,
        total_size_bytes,
        needs_elevation,
    })
}

/// Fallback when the path isn't in a default root (custom folder): build the
/// entry directly so leftover matching still works.
fn synthesize_entry(plugin_path: &str) -> Option<PluginEntry> {
    let path = Path::new(plugin_path);
    if !path.exists() {
        return None;
    }
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let format = match ext.as_str() {
        "vst" => "vst",
        "vst3" => "vst3",
        "component" => "au",
        "clap" => "clap",
        "aaxplugin" => "aax",
        "dll" => "vst",
        _ => return None,
    };
    let mut entry = PluginEntry {
        name: path.file_stem()?.to_str()?.to_string(),
        path: plugin_path.to_string(),
        format: format.to_string(),
        kind: "unknown".to_string(),
        scope: "custom".to_string(),
        vendor: None,
        bundle_id: None,
        size_bytes: 0,
        siblings: Vec::new(),
    };
    metadata::enrich(&mut entry);
    Some(entry)
}

fn normalize_vendor(vendor: &str) -> String {
    let mut norm = normalize_name(vendor);
    for suffix in ["llc", "inc", "ltd", "gmbh", "corp"] {
        if let Some(stripped) = norm.strip_suffix(suffix) {
            if stripped.len() >= 4 {
                norm = stripped.to_string();
            }
        }
    }
    norm
}

/// Exact match, or prefix match with the shorter side ≥5 chars — covers
/// "ValhallaDSP" vs "Valhalla DSP LLC" without opening the door to short
/// accidental prefixes.
fn vendor_matches(candidate: &str, vendor: &str) -> bool {
    if candidate.is_empty() || vendor.is_empty() {
        return false;
    }
    if candidate == vendor {
        return true;
    }
    let (short, long) = if candidate.len() < vendor.len() {
        (candidate, vendor)
    } else {
        (vendor, candidate)
    };
    short.len() >= 5 && long.starts_with(short)
}

/// The sweep locations as plain paths — reused by deletion's whitelist guard.
pub fn sweep_root_paths() -> Vec<PathBuf> {
    sweep_roots().into_iter().map(|r| r.path).collect()
}

pub fn requires_elevation(item: &LeftoverItem) -> bool {
    if item.is_registry_key {
        return item.path.starts_with("HKLM");
    }
    path_requires_elevation(&item.path)
}

#[cfg(target_os = "macos")]
pub fn path_requires_elevation(path: &str) -> bool {
    path.starts_with("/Library") || path.starts_with("/Network")
}

#[cfg(target_os = "windows")]
pub fn path_requires_elevation(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    for var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)"] {
        if let Ok(base) = std::env::var(var) {
            if lower.starts_with(&base.to_ascii_lowercase()) {
                return true;
            }
        }
    }
    false
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn path_requires_elevation(_path: &str) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn sweep_roots() -> Vec<SweepRoot> {
    let home = std::env::var("HOME").unwrap_or_default();
    let user = |p: &str, category| SweepRoot {
        path: PathBuf::from(format!("{home}/{p}")),
        category,
    };
    vec![
        user("Library/Application Support", "appSupport"),
        SweepRoot { path: PathBuf::from("/Library/Application Support"), category: "appSupport" },
        user("Library/Audio/Presets", "presets"),
        user("Library/Preferences", "prefs"),
        user("Library/Caches", "caches"),
        user("Library/Saved Application State", "caches"),
        user("Documents", "documents"),
        user("Music", "documents"),
        user("Library/Mobile Documents/com~apple~CloudDocs", "icloud"),
    ]
}

#[cfg(target_os = "windows")]
fn sweep_roots() -> Vec<SweepRoot> {
    let mut roots = Vec::new();
    let mut add = |var: &str, suffix: &str, category: &'static str| {
        if let Ok(base) = std::env::var(var) {
            roots.push(SweepRoot {
                path: PathBuf::from(if suffix.is_empty() {
                    base
                } else {
                    format!("{base}\\{suffix}")
                }),
                category,
            });
        }
    };
    add("PROGRAMDATA", "", "appSupport");
    add("APPDATA", "", "appSupport");
    add("LOCALAPPDATA", "", "appSupport");
    add("USERPROFILE", "Documents", "documents");
    add("PUBLIC", "Documents", "documents");
    roots
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn sweep_roots() -> Vec<SweepRoot> {
    Vec::new()
}

#[cfg(target_os = "windows")]
fn sweep_registry(
    target: &PluginEntry,
    plugin_norm: &str,
    vendor_norm: Option<&str>,
    vendor_shared: bool,
    seen: &mut HashSet<String>,
    items: &mut Vec<LeftoverItem>,
) {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let _ = target;
    let mut push = |path: String, confidence: &str, shared: bool| {
        if seen.insert(path.clone()) {
            items.push(LeftoverItem {
                path,
                size_bytes: 0,
                category: "registry".to_string(),
                confidence: confidence.to_string(),
                shared,
                is_registry_key: true,
            });
        }
    };

    for (hive, hive_name, base) in [
        (RegKey::predef(HKEY_CURRENT_USER), "HKCU", "Software"),
        (RegKey::predef(HKEY_LOCAL_MACHINE), "HKLM", "SOFTWARE"),
    ] {
        let Ok(software) = hive.open_subkey(base) else { continue };
        for key_name in software.enum_keys().flatten() {
            let key_norm = normalize_name(&key_name);
            let full = format!("{hive_name}\\{base}\\{key_name}");
            if key_norm == plugin_norm && !key_norm.is_empty() {
                push(full, "high", false);
            } else if let Some(vn) = vendor_norm {
                if vendor_matches(&key_norm, vn) {
                    if let Ok(vendor_key) = software.open_subkey(&key_name) {
                        for sub in vendor_key.enum_keys().flatten() {
                            if normalize_name(&sub) == plugin_norm {
                                push(format!("{full}\\{sub}"), "high", false);
                            }
                        }
                    }
                    push(full, "vendor", vendor_shared);
                }
            }
        }
    }
}
