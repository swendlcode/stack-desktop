//! Browser → backend command dispatch.
//!
//! The HTTP server reuses the exact same `#[tauri::command]` functions the
//! desktop webview invokes — they are ordinary async fns. We obtain a
//! `State<AppState>` via `app.state()` and pass `app.clone()` where a command
//! needs the `AppHandle`, so there is zero business-logic duplication here.
//!
//! Argument keys are the camelCase names the frontend passes to `invoke(...)`.

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::commands::{
    asset_commands as ac, library_commands as lc, pack_commands as pc,
    player_commands as plc, plugin_commands as plg, project_commands as prj,
    settings_commands as sc, update_commands as upc, url_image_commands as uic,
};
use crate::error::StackError;

fn to_val<T: Serialize>(v: T) -> Result<Value, StackError> {
    serde_json::to_value(v).map_err(|e| StackError::Other(e.to_string()))
}

fn field<T: DeserializeOwned>(body: &Value, key: &str) -> Result<T, StackError> {
    serde_json::from_value(body.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| StackError::Other(format!("invalid argument '{}': {}", key, e)))
}

/// Dispatch a single command by name. `body` is the JSON args object the
/// frontend sent (camelCase keys, mirroring the desktop `invoke(cmd, args)`).
pub async fn dispatch(app: AppHandle, cmd: &str, body: Value) -> Result<Value, StackError> {
    // `f!("key")` pulls and deserializes one argument into the inferred type.
    macro_rules! f {
        ($k:expr) => {
            field(&body, $k)?
        };
    }

    match cmd {
        // ── assets ──────────────────────────────────────────────────────────
        "search_assets" => to_val(ac::search_assets(f!("query"), app.state()).await?),
        "get_asset" => to_val(ac::get_asset(f!("id"), app.state()).await?),
        "asset_exists" => to_val(ac::asset_exists(f!("id"), app.state()).await?),
        "toggle_favorite" => to_val(ac::toggle_favorite(f!("id"), app.state()).await?),
        "add_tag" => to_val(ac::add_tag(f!("id"), f!("tag"), app.state()).await?),
        "remove_tag" => to_val(ac::remove_tag(f!("id"), f!("tag"), app.state()).await?),
        "increment_play_count" => {
            to_val(ac::increment_play_count(f!("id"), app.state()).await?)
        }
        "get_waveform" => {
            to_val(ac::get_waveform(f!("id"), app.clone(), app.state()).await?)
        }
        "get_midi_notes" => to_val(ac::get_midi_notes(f!("id"), app.state()).await?),
        "get_facet_counts" => to_val(ac::get_facet_counts(f!("filters"), app.state()).await?),
        "find_similar" => to_val(ac::find_similar(f!("id"), f!("limit"), app.state()).await?),

        // ── library ─────────────────────────────────────────────────────────
        "scan_folder" => to_val(lc::scan_folder(f!("path"), app.state()).await?),
        "add_watched_folder" => to_val(lc::add_watched_folder(f!("path"), app.state()).await?),
        "add_project_folder" => to_val(lc::add_project_folder(f!("path"), app.state()).await?),
        "remove_watched_folder" => {
            to_val(lc::remove_watched_folder(f!("id"), app.state()).await?)
        }
        "get_watched_folders" => to_val(lc::get_watched_folders(app.state()).await?),
        "cancel_scan" => to_val(lc::cancel_scan(app.state()).await?),
        "get_scan_progress" => to_val(lc::get_scan_progress(app.state()).await?),
        "run_reconciliation" => {
            to_val(lc::run_reconciliation(app.clone(), app.state()).await?)
        }
        "clean_cache" => to_val(lc::clean_cache(app.state()).await?),
        "hard_clean_cache" => to_val(lc::hard_clean_cache(app.state()).await?),
        "get_library_tree" => to_val(lc::get_library_tree(app.state()).await?),
        "get_folder_info" => to_val(lc::get_folder_info(f!("path"), app.state()).await?),
        "get_project_info" => to_val(lc::get_project_info(f!("path")).await?),
        "move_library_folder" => to_val(
            lc::move_library_folder(f!("fromPath"), f!("toParentPath"), app.clone(), app.state())
                .await?,
        ),

        // ── packs ───────────────────────────────────────────────────────────
        "get_packs" => to_val(pc::get_packs(app.state()).await?),
        "get_pack" => to_val(pc::get_pack(f!("id"), app.state()).await?),
        "set_pack_color" => to_val(pc::set_pack_color(f!("id"), f!("color"), app.state()).await?),
        "get_pack_assets" => to_val(
            pc::get_pack_assets(f!("id"), f!("limit"), f!("offset"), app.state()).await?,
        ),
        "get_pack_cover" => to_val(pc::get_pack_cover(f!("packRoot")).await?),
        "set_pack_artwork" => {
            to_val(pc::set_pack_artwork(f!("packRoot"), f!("dataBase64"), f!("mime")).await?)
        }
        "clear_pack_artwork" => to_val(pc::clear_pack_artwork(f!("packRoot")).await?),
        "get_pack_description" => to_val(pc::get_pack_description(f!("packRoot")).await?),
        "set_pack_description" => {
            to_val(pc::set_pack_description(f!("packRoot"), f!("description")).await?)
        }
        "delete_pack" => to_val(pc::delete_pack(f!("id"), app.clone(), app.state()).await?),
        "rescan_pack" => to_val(pc::rescan_pack(f!("id"), app.state()).await?),

        // ── player ──────────────────────────────────────────────────────────
        "decode_audio" => to_val(plc::decode_audio(f!("id"), app.state()).await?),

        // ── settings ────────────────────────────────────────────────────────
        "get_settings" => to_val(sc::get_settings(app.state()).await?),
        "update_settings" => {
            to_val(sc::update_settings(f!("settings"), app.clone(), app.state()).await?)
        }
        "sync_autostart" => to_val(sc::sync_autostart(app.clone(), app.state()).await?),

        // ── plugins / project / misc ────────────────────────────────────────
        "scan_plugins" => to_val(plg::scan_plugins(f!("formats"), f!("extraPaths"))?),
        "open_project_in_daw" => to_val(prj::open_project_in_daw(f!("projectPath")).await?),
        "open_with_default_app" => to_val(prj::open_with_default_app(f!("path")).await?),
        "fetch_url_image" => {
            to_val(uic::fetch_url_image(f!("url")).await.map_err(StackError::Other)?)
        }
        "check_for_update" => {
            to_val(upc::check_for_update().await.map_err(StackError::Other)?)
        }

        // Native drag-and-drop (get_drag_icon / save_export) has no browser
        // equivalent and is intentionally desktop-only.
        other => Err(StackError::Other(format!(
            "command '{}' is not available over the web bridge",
            other
        ))),
    }
}
