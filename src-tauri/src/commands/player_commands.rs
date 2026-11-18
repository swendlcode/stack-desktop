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
