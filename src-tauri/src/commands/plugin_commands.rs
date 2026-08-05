use crate::core::plugins;
use crate::error::{Result, StackError};
use crate::models::{DeleteReport, LeftoverReport, PluginEntry};

fn join_err(e: tokio::task::JoinError) -> StackError {
    StackError::Other(e.to_string())
}

#[tauri::command]
pub async fn scan_plugins(
    formats: Vec<String>,
    extra_paths: Vec<String>,
) -> Result<Vec<PluginEntry>> {
    tokio::task::spawn_blocking(move || plugins::scan(&formats, &extra_paths))
        .await
        .map_err(join_err)
}

#[tauri::command]
pub async fn find_plugin_leftovers(
    plugin_path: String,
    extra_paths: Vec<String>,
) -> Result<LeftoverReport> {
    tokio::task::spawn_blocking(move || plugins::leftovers::find(&plugin_path, &extra_paths))
        .await
        .map_err(join_err)?
}

#[tauri::command]
pub async fn delete_plugin(
    paths: Vec<String>,
    registry_keys: Vec<String>,
    extra_roots: Vec<String>,
) -> Result<DeleteReport> {
    tokio::task::spawn_blocking(move || plugins::deletion::delete(paths, registry_keys, extra_roots))
        .await
        .map_err(join_err)?
}
