//! Best-effort vendor / bundle-id / size extraction for scanned plugins.

use std::path::Path;

use walkdir::WalkDir;

use crate::models::PluginEntry;

pub fn enrich(entry: &mut PluginEntry) {
    let path = Path::new(&entry.path);
    entry.size_bytes = total_size(path);

    // VST3 bundles ship Contents/moduleinfo.json with a display-quality vendor.
    entry.vendor = moduleinfo_vendor(path);

    // macOS-style bundles: all formats on macOS, .vst3/.aaxplugin dirs on Windows.
    if let Some(bundle_id) = info_plist_bundle_id(path) {
        if entry.vendor.is_none() {
            entry.vendor = vendor_from_bundle_id(&bundle_id);
        }
        entry.bundle_id = Some(bundle_id);
    }
}

pub fn total_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if !meta.is_dir() {
        return meta.len();
    }
    WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

fn moduleinfo_vendor(bundle: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(bundle.join("Contents/moduleinfo.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let vendor = json
        .get("Factory Info")
        .and_then(|f| f.get("Vendor"))
        .or_else(|| json.get("Vendor"))?
        .as_str()?
        .trim();
    (!vendor.is_empty()).then(|| vendor.to_string())
}

fn info_plist_bundle_id(bundle: &Path) -> Option<String> {
    let plist_path = bundle.join("Contents/Info.plist");
    if !plist_path.exists() {
        return None;
    }
    let value = plist::Value::from_file(&plist_path).ok()?;
    let id = value
        .as_dictionary()?
        .get("CFBundleIdentifier")?
        .as_string()?
        .trim();
    (!id.is_empty()).then(|| id.to_string())
}

/// `com.valhalladsp.supermassive` → `valhalladsp` (capitalized). Rough, but
/// only used when no moduleinfo.json vendor exists.
fn vendor_from_bundle_id(bundle_id: &str) -> Option<String> {
    let token = bundle_id.split('.').nth(1)?.trim();
    if token.is_empty() {
        return None;
    }
    let mut chars = token.chars();
    let first = chars.next()?.to_uppercase().to_string();
    Some(format!("{first}{}", chars.as_str()))
}
