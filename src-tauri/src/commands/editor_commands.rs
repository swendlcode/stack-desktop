//! The sample editor's commands.
//!
//! Thin, like every other command file: validate, hand to `core::playback`,
//! return the state the frontend renders from. Anything that decodes or
//! renders goes through `spawn_blocking`, because it is real work and the
//! async runtime is shared with the indexer.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::core::playback::editor::EditorState;
use crate::error::{Result, StackError};
use crate::state::AppState;

#[tauri::command]
pub async fn editor_load(path: String, state: State<'_, AppState>) -> Result<EditorState> {
    let player = state.player.clone();
    let rate = player.output_rate()?;
    tokio::task::spawn_blocking(move || player.editor().load(&PathBuf::from(path), rate))
        .await
        .map_err(|e| StackError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn editor_unload(state: State<'_, AppState>) -> Result<EditorState> {
    state.player.editor().unload()
}

#[tauri::command]
pub async fn editor_reset(state: State<'_, AppState>) -> Result<EditorState> {
    state.player.editor().reset_edits()
}

#[tauri::command]
pub async fn editor_play(
    from_sec: Option<f64>,
    state: State<'_, AppState>,
) -> Result<EditorState> {
    state.player.editor().play(from_sec)
}

#[tauri::command]
pub async fn editor_pause(state: State<'_, AppState>) -> Result<EditorState> {
    state.player.editor().pause()
}

#[tauri::command]
pub async fn editor_stop(state: State<'_, AppState>) -> Result<EditorState> {
    state.player.editor().stop()
}

#[tauri::command]
pub async fn editor_seek(sec: f64, state: State<'_, AppState>) -> Result<EditorState> {
    state.player.editor().seek(sec)
}

/// Every live control in one call.
///
/// They are sliders: one command that takes whatever moved keeps a drag to a
/// single round trip per frame instead of one per parameter, and they all
/// return the same state anyway.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    pub volume: Option<f32>,
    pub rate: Option<f32>,
    pub pitch_semitones: Option<f32>,
    pub high_cut_hz: Option<f32>,
    pub low_cut_hz: Option<f32>,
    pub loop_on: Option<bool>,
    pub loop_start: Option<f64>,
    pub loop_end: Option<f64>,
}

#[tauri::command]
pub async fn editor_set(
    settings: EditorSettings,
    state: State<'_, AppState>,
) -> Result<EditorState> {
    let editor = state.player.editor();
    if let Some(v) = settings.volume {
        editor.set_volume(v)?;
    }
    if let Some(r) = settings.rate {
        editor.set_rate(r)?;
    }
    if let Some(p) = settings.pitch_semitones {
        editor.set_pitch(p)?;
    }
    if let Some(hz) = settings.high_cut_hz {
        editor.set_high_cut(hz)?;
    }
    if let Some(hz) = settings.low_cut_hz {
        editor.set_low_cut(hz)?;
    }
    if settings.loop_on.is_some() || settings.loop_start.is_some() || settings.loop_end.is_some() {
        let current = editor.state();
        editor.set_loop(
            settings.loop_on.unwrap_or(current.loop_on),
            settings.loop_start,
            settings.loop_end,
        )?;
    }
    Ok(editor.state())
}

#[tauri::command]
pub async fn editor_reverse(state: State<'_, AppState>) -> Result<EditorState> {
    let player = state.player.clone();
    tokio::task::spawn_blocking(move || player.editor().reverse())
        .await
        .map_err(|e| StackError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn editor_normalize(state: State<'_, AppState>) -> Result<EditorState> {
    let player = state.player.clone();
    tokio::task::spawn_blocking(move || player.editor().normalize())
        .await
        .map_err(|e| StackError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn editor_delete_region(
    start_sec: f64,
    end_sec: f64,
    state: State<'_, AppState>,
) -> Result<EditorState> {
    let player = state.player.clone();
    tokio::task::spawn_blocking(move || player.editor().delete_region(start_sec, end_sec))
        .await
        .map_err(|e| StackError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn editor_state(state: State<'_, AppState>) -> Result<EditorState> {
    Ok(state.player.editor().state())
}

/// Peak per channel since the last call, which this clears.
#[tauri::command]
pub async fn editor_levels(state: State<'_, AppState>) -> Result<(f32, f32)> {
    Ok(state.player.editor().levels())
}

/// The working buffer downmixed to mono, as raw little-endian f32.
///
/// Returned as bytes rather than a JSON array of numbers: a fifteen-second
/// sample is around three quarters of a million values, and serialising that
/// as text costs more than the decode did. The frontend wraps the response in
/// a `Float32Array` with no copy.
#[tauri::command]
pub async fn editor_waveform(state: State<'_, AppState>) -> Result<tauri::ipc::Response> {
    let player = state.player.clone();
    let mono = tokio::task::spawn_blocking(move || player.editor().waveform())
        .await
        .map_err(|e| StackError::Other(e.to_string()))?;
    let mut bytes = Vec::with_capacity(mono.len() * 4);
    for sample in mono {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

/// Render the edit to a WAV beside the other drag exports, and return its
/// path so the drag can pick it up.
///
/// Nothing crosses the IPC boundary but the filename and the path. The old
/// route rendered in the webview, encoded a WAV there, and shipped roughly
/// three megabytes back to Rust as a JSON array of integers to be written to
/// disk.
#[tauri::command]
pub async fn editor_export(
    filename: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| StackError::Other(e.to_string()))?
        .join("exports");
    std::fs::create_dir_all(&dir)?;
    let safe: String = filename
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || "._- ".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let target = dir.join(safe);
    let player = state.player.clone();
    let written = tokio::task::spawn_blocking(move || player.editor().export(&target))
        .await
        .map_err(|e| StackError::Other(e.to_string()))??;
    Ok(written.to_string_lossy().into_owned())
}
