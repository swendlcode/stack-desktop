use std::time::{SystemTime, UNIX_EPOCH};

use tauri::State;
use uuid::Uuid;

use crate::error::{Result, StackError};
use crate::models::{Asset, Stack};
use crate::state::AppState;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[tauri::command]
pub async fn list_stacks(state: State<'_, AppState>) -> Result<Vec<Stack>> {
    let repo = state.stack_repo.clone();
    tokio::task::spawn_blocking(move || repo.list())
        .await
        .map_err(|e| StackError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn create_stack(name: String, state: State<'_, AppState>) -> Result<Stack> {
    let repo = state.stack_repo.clone();
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    tokio::task::spawn_blocking(move || repo.create(&id, &name, now))
        .await
        .map_err(|e| StackError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn rename_stack(id: String, name: String, state: State<'_, AppState>) -> Result<()> {
    let repo = state.stack_repo.clone();
    tokio::task::spawn_blocking(move || repo.rename(&id, &name))
        .await
        .map_err(|e| StackError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn set_stack_color(id: String, color: String, state: State<'_, AppState>) -> Result<()> {
    let repo = state.stack_repo.clone();
    tokio::task::spawn_blocking(move || repo.set_color(&id, &color))
        .await
        .map_err(|e| StackError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn delete_stack(id: String, state: State<'_, AppState>) -> Result<()> {
    let repo = state.stack_repo.clone();
    tokio::task::spawn_blocking(move || repo.delete(&id))
        .await
        .map_err(|e| StackError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn add_asset_to_stack(
    stack_id: String,
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let repo = state.stack_repo.clone();
    let now = now_ms();
    tokio::task::spawn_blocking(move || repo.add_asset(&stack_id, &asset_id, now))
        .await
        .map_err(|e| StackError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn remove_asset_from_stack(
    stack_id: String,
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let repo = state.stack_repo.clone();
    tokio::task::spawn_blocking(move || repo.remove_asset(&stack_id, &asset_id))
        .await
        .map_err(|e| StackError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn get_stack_assets(
    id: String,
    limit: Option<i64>,
    offset: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<Asset>> {
    let repo = state.asset_repo.clone();
    let limit = limit.unwrap_or(500);
    let offset = offset.unwrap_or(0);
    tokio::task::spawn_blocking(move || repo.by_stack(&id, limit, offset))
        .await
        .map_err(|e| StackError::Other(e.to_string()))?
}
