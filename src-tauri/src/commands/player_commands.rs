use tauri::State;

use crate::error::Result;
use crate::state::AppState;

/// Return the asset path so the frontend can stream via the Tauri asset protocol
/// or load as a blob. Audio decoding happens in the browser's Web Audio API.
#[tauri::command]
pub async fn decode_audio(id: String, state: State<'_, AppState>) -> Result<String> {
    let repo = state.asset_repo.clone();
    let lookup_id = id.clone();
    let asset = tokio::task::spawn_blocking(move || repo.get_by_id(&lookup_id))
        .await
        .map_err(|e| crate::error::StackError::Other(e.to_string()))??;
    let asset = asset.ok_or_else(|| crate::error::StackError::NotFound(id))?;
    Ok(asset.path)
}

/// Append a line to `<app data>/audio-log.txt`.
///
/// The audio engine's event ring lives in the webview, which means it dies
/// with the webview — and the failure we are chasing is one the user escapes
/// by restarting the app. Writing the ring to disk the moment a play comes
/// out late is the difference between a report that says "it felt slow" and
/// one that says which path took how many milliseconds.
#[tauri::command]
pub async fn append_audio_log(app: tauri::AppHandle, text: String) -> Result<()> {
    use std::io::Write;
    use tauri::Manager;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::error::StackError::Other(e.to_string()))?;
    let path = dir.join("audio-log.txt");
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        std::fs::create_dir_all(path.parent().unwrap_or(&path))?;
        // Truncate rather than grow without bound: only the most recent
        // episode is ever of interest, and an unbounded log in the user's
        // application data is litter.
        let existing = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(existing < 2_000_000)
            .truncate(existing >= 2_000_000)
            .open(&path)?;
        writeln!(file, "{text}")
    })
    .await
    .map_err(|e| crate::error::StackError::Other(e.to_string()))?
    .map_err(|e| crate::error::StackError::Other(e.to_string()))?;
    Ok(())
}

// ─── Backend playback ────────────────────────────────────────────────────────
//
// The output device is owned by the Rust side now. These are thin wrappers:
// anything that can decode goes through `spawn_blocking`, because decoding a
// fifteen-second stereo loop is real work and the async runtime is shared
// with the indexer.

use std::path::PathBuf;

use crate::core::PlaybackState;

/// Start a sample. `offsetSec` past the end starts from the top instead.
#[tauri::command]
pub async fn audio_play(
    path: String,
    offset_sec: Option<f64>,
    state: State<'_, AppState>,
) -> Result<PlaybackState> {
    let player = state.player.clone();
    let offset = offset_sec.unwrap_or(0.0);
    tokio::task::spawn_blocking(move || player.play(PathBuf::from(path), offset))
        .await
        .map_err(|e| crate::error::StackError::Other(e.to_string()))?
}

/// Decode ahead of a press. Never disturbs what is playing.
#[tauri::command]
pub async fn audio_prefetch(paths: Vec<String>, state: State<'_, AppState>) -> Result<()> {
    let player = state.player.clone();
    tokio::task::spawn_blocking(move || {
        for path in paths {
            // One bad file does not stop the rest of the neighbourhood.
            let _ = player.prefetch(PathBuf::from(path));
        }
    })
    .await
    .map_err(|e| crate::error::StackError::Other(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn audio_stop(state: State<'_, AppState>) -> Result<()> {
    state.player.stop()
}

#[tauri::command]
pub async fn audio_pause(state: State<'_, AppState>) -> Result<()> {
    state.player.pause()
}

#[tauri::command]
pub async fn audio_resume(state: State<'_, AppState>) -> Result<()> {
    state.player.resume()
}

#[tauri::command]
pub async fn audio_seek(position_sec: f64, state: State<'_, AppState>) -> Result<()> {
    state.player.seek(position_sec)
}

#[tauri::command]
pub async fn audio_set_volume(volume: f32, state: State<'_, AppState>) -> Result<()> {
    state.player.set_volume(volume)
}

/// Repeat the sample instead of ending it. Survives changing sample.
#[tauri::command]
pub async fn audio_set_loop(enabled: bool, state: State<'_, AppState>) -> Result<()> {
    state.player.set_loop(enabled)
}

/// The transport, the device and the cache, for the UI and for diagnostics.
#[tauri::command]
pub async fn audio_state(state: State<'_, AppState>) -> Result<PlaybackState> {
    Ok(state.player.state())
}

/// Reopen the output stream. The device thread already does this by itself
/// when the default output moves; this is for a user asking explicitly.
#[tauri::command]
pub async fn audio_reopen_device(state: State<'_, AppState>) -> Result<()> {
    state.player.reopen_device()
}

/// Play a short sine through the real output path, decoding nothing.
#[tauri::command]
pub async fn audio_test_tone(state: State<'_, AppState>) -> Result<PlaybackState> {
    state.player.test_tone()
}

/// Render and play a MIDI performance through the same mixer as a sample.
#[tauri::command]
pub async fn audio_play_midi(
    notes: Vec<crate::core::MidiNote>,
    duration_sec: f64,
    offset_sec: Option<f64>,
    state: State<'_, AppState>,
) -> Result<PlaybackState> {
    let player = state.player.clone();
    let offset = offset_sec.unwrap_or(0.0);
    tokio::task::spawn_blocking(move || player.play_midi(&notes, duration_sec, offset))
        .await
        .map_err(|e| crate::error::StackError::Other(e.to_string()))?
}
