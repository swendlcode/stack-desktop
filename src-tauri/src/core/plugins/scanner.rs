//! Plugin discovery across the standard install locations for each OS.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::models::{PluginEntry, PluginSibling};

use super::metadata;

/// A directory the OS designates for one plugin format family.
pub struct PluginRoot {
    pub path: PathBuf,
    /// vst | vst3 | au | clap | aax
    pub format: &'static str,
    /// system | user
    pub scope: &'static str,
}

pub fn scan(formats: &[String], extra_paths: &[String]) -> Vec<PluginEntry> {
    let requested: HashSet<String> = formats.iter().map(|f| f.to_lowercase()).collect();

    let mut out: Vec<PluginEntry> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();

    for root in default_roots() {
        if !requested.is_empty() && !requested.contains(root.format) {
            continue;
        }
        scan_root(&root.path, root.format, root.scope, &mut out, &mut seen);
    }

    for path in extra_paths {
        scan_root(Path::new(path), "custom", "custom", &mut out, &mut seen);
    }

    for entry in out.iter_mut() {
        metadata::enrich(entry);
    }
    attach_siblings(&mut out);

    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

fn scan_root(
    root: &Path,
    root_format: &str,
    scope: &str,
    out: &mut Vec<PluginEntry>,
    seen: &mut HashSet<PathBuf>,
) {
    if !root.exists() {
        return;
    }
    // Bare .dll files are only trustworthy as VST2 inside VST2-designated dirs.
    let allow_dll = cfg!(windows) && matches!(root_format, "vst" | "custom");

    let mut it = WalkDir::new(root).follow_links(true).into_iter();
    loop {
        let entry = match it.next() {
            None => break,
            Some(Ok(e)) => e,
            Some(Err(_)) => continue,
        };
        let path = entry.path();
        let Some(ext) = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
        else {
            continue;
        };

        let is_dir = entry.file_type().is_dir();
        let format = match ext.as_str() {
            "vst" => "vst",
            "vst3" => "vst3",
            "component" => "au",
            "clap" => "clap",
            "aaxplugin" => "aax",
            "dll" if allow_dll && !is_dir => "vst",
            _ => continue,
        };

        // Dedupe on the canonical path so a symlinked install (e.g. a vendor
        // linking /Library/Audio/Plug-Ins/VST3/X.vst3 into /Applications)
        // still counts as one plugin, while keeping the conventional path.
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if seen.insert(canonical) {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown Plugin")
                .to_string();
            out.push(PluginEntry {
                kind: classify_kind(&name),
                name,
                path: path.to_string_lossy().to_string(),
                format: format.to_string(),
                scope: scope.to_string(),
                vendor: None,
                bundle_id: None,
                size_bytes: 0,
                siblings: Vec::new(),
            });
        }

        // A bundle directory (all formats on macOS; .vst3/.clap/.aaxplugin
        // folders on Windows) is one plugin — never descend into it.
        if is_dir {
            it.skip_current_dir();
        }
    }
}

fn classify_kind(name: &str) -> String {
    let lower = name.to_lowercase();
    let instrument_hints = [
        "synth",
        "sampler",
        "instrument",
        "piano",
        "keys",
        "organ",
        "drum",
        "bass",
        "rompler",
    ];
    if instrument_hints.iter().any(|h| lower.contains(h)) {
        "instrument".to_string()
    } else {
        "effect".to_string()
    }
}

/// Collapse a plugin display name to a comparison key: lowercase, alphanumeric
/// only, with trailing architecture/format tokens dropped so "Serum x64" and
/// "Serum" group together.
pub fn normalize_name(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut tokens: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    while tokens.len() > 1 {
        match *tokens.last().unwrap() {
            "x64" | "x86" | "win64" | "win32" | "64" | "32" | "vst" | "vst2" | "vst3" | "au"
            | "clap" | "aax" => {
                tokens.pop();
            }
            _ => break,
        }
    }
    tokens.join("")
}

fn attach_siblings(entries: &mut [PluginEntry]) {
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, e) in entries.iter().enumerate() {
        groups.entry(normalize_name(&e.name)).or_default().push(i);
    }

    let mut assignments: Vec<(usize, Vec<PluginSibling>)> = Vec::new();
    for indices in groups.values() {
        if indices.len() < 2 {
            continue;
        }
        for &i in indices {
            let sibs = indices
                .iter()
                .filter(|&&j| j != i)
                .map(|&j| PluginSibling {
                    path: entries[j].path.clone(),
                    format: entries[j].format.clone(),
                })
                .collect();
            assignments.push((i, sibs));
        }
    }
    for (i, sibs) in assignments {
        entries[i].siblings = sibs;
    }
}

#[cfg(target_os = "macos")]
pub fn default_roots() -> Vec<PluginRoot> {
    let home = std::env::var("HOME").unwrap_or_default();
    let sys = |p: &str| PathBuf::from(format!("/Library/Audio/Plug-Ins/{p}"));
    let usr = |p: &str| PathBuf::from(format!("{home}/Library/Audio/Plug-Ins/{p}"));
    let root = |path, format, scope| PluginRoot { path, format, scope };

    vec![
        root(sys("VST"), "vst", "system"),
        root(usr("VST"), "vst", "user"),
        root(sys("VST3"), "vst3", "system"),
        root(usr("VST3"), "vst3", "user"),
        root(
            PathBuf::from("/Network/Library/Audio/Plug-Ins/VST3"),
            "vst3",
            "system",
        ),
        root(sys("Components"), "au", "system"),
        root(usr("Components"), "au", "user"),
        root(sys("CLAP"), "clap", "system"),
        root(usr("CLAP"), "clap", "user"),
        root(
            PathBuf::from("/Library/Application Support/Avid/Audio/Plug-Ins"),
            "aax",
            "system",
        ),
    ]
}

#[cfg(target_os = "windows")]
pub fn default_roots() -> Vec<PluginRoot> {
    let mut roots: Vec<PluginRoot> = Vec::new();
    let mut push = |path: String, format: &'static str, scope: &'static str| {
        roots.push(PluginRoot {
            path: PathBuf::from(path),
            format,
            scope,
        });
    };

    let common = std::env::var("COMMONPROGRAMFILES")
        .unwrap_or_else(|_| r"C:\Program Files\Common Files".to_string());
    let common_x86 = std::env::var("COMMONPROGRAMFILES(X86)").ok();
    let pf = std::env::var("PROGRAMFILES").unwrap_or_else(|_| r"C:\Program Files".to_string());
    let pf_x86 = std::env::var("PROGRAMFILES(X86)").ok();
    let local = std::env::var("LOCALAPPDATA").ok();

    push(format!(r"{common}\VST3"), "vst3", "system");
    push(format!(r"{common}\CLAP"), "clap", "system");
    push(format!(r"{common}\VST2"), "vst", "system");
    push(format!(r"{common}\Avid\Audio\Plug-Ins"), "aax", "system");
    if let Some(cx) = &common_x86 {
        push(format!(r"{cx}\VST3"), "vst3", "system");
        push(format!(r"{cx}\CLAP"), "clap", "system");
        push(format!(r"{cx}\VST2"), "vst", "system");
    }
    // Per-user locations from the VST3 / CLAP specs.
    if let Some(l) = &local {
        push(format!(r"{l}\Programs\Common\VST3"), "vst3", "user");
        push(format!(r"{l}\Programs\Common\CLAP"), "clap", "user");
    }
    // Conventional VST2 dirs (the VST2 standard never mandated one).
    push(format!(r"{pf}\VstPlugins"), "vst", "system");
    push(format!(r"{pf}\Steinberg\VstPlugins"), "vst", "system");
    if let Some(px) = &pf_x86 {
        push(format!(r"{px}\VstPlugins"), "vst", "system");
        push(format!(r"{px}\Steinberg\VstPlugins"), "vst", "system");
    }
    // The user-configured VST2 dir most installers honor.
    for path in registry_vst2_paths() {
        push(path, "vst", "system");
    }

    roots
}

#[cfg(target_os = "windows")]
fn registry_vst2_paths() -> Vec<String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let mut out = Vec::new();
    for subkey in ["SOFTWARE\\VST", "SOFTWARE\\Wow6432Node\\VST"] {
        if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(subkey) {
            if let Ok(path) = key.get_value::<String, _>("VSTPluginsPath") {
                if !path.trim().is_empty() {
                    out.push(path);
                }
            }
        }
    }
    out
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn default_roots() -> Vec<PluginRoot> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_dirs_count_once_and_are_not_descended() {
        let tmp = std::env::temp_dir().join(format!("stack-scan-test-{}", std::process::id()));
        let bundle = tmp.join("Serum.vst3");
        std::fs::create_dir_all(bundle.join("Contents/x86_64-win")).unwrap();
        // A nested file with a plugin extension must NOT become a second entry.
        std::fs::write(bundle.join("Contents/x86_64-win/Serum.vst3"), b"x").unwrap();
        std::fs::write(tmp.join("Other.clap"), b"x").unwrap();

        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        scan_root(&tmp, "custom", "custom", &mut out, &mut seen);
        std::fs::remove_dir_all(&tmp).unwrap();

        let mut found: Vec<(String, String)> = out
            .into_iter()
            .map(|e| (e.name, e.format))
            .collect();
        found.sort();
        assert_eq!(
            found,
            vec![
                ("Other".to_string(), "clap".to_string()),
                ("Serum".to_string(), "vst3".to_string()),
            ]
        );
    }

    #[test]
    fn normalize_strips_arch_and_format_suffixes() {
        assert_eq!(normalize_name("Serum x64"), "serum");
        assert_eq!(normalize_name("ValhallaSupermassive_VST3"), "valhallasupermassive");
        assert_eq!(normalize_name("Pro-Q 3"), "proq3");
        // Never strip down to nothing.
        assert_eq!(normalize_name("VST3"), "vst3");
    }
}
