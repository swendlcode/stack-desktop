use serde::{Deserialize, Serialize};

/// A user-created folder of favorited assets (`stacks` + `stack_assets` tables).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stack {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub asset_count: i64,
    pub created_at: i64,
}
