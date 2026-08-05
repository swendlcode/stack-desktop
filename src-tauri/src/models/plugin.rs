use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    pub name: String,
    pub path: String,
    pub format: String,
    pub kind: String,
    pub scope: String,
    pub vendor: Option<String>,
    pub bundle_id: Option<String>,
    pub size_bytes: u64,
    pub siblings: Vec<PluginSibling>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSibling {
    pub path: String,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverItem {
    pub path: String,
    pub size_bytes: u64,
    /// binary | sibling | presets | appSupport | prefs | caches | documents | icloud | registry
    pub category: String,
    /// exact | high | vendor
    pub confidence: String,
    /// Other installed plugins from the same vendor also use this location.
    pub shared: bool,
    pub is_registry_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverReport {
    pub plugin_name: String,
    pub vendor: Option<String>,
    pub bundle_id: Option<String>,
    pub items: Vec<LeftoverItem>,
    pub total_size_bytes: u64,
    pub needs_elevation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    pub deleted: Vec<String>,
    pub failed: Vec<DeleteFailure>,
    pub bytes_freed: u64,
    pub elevation_used: bool,
    pub elevation_cancelled: bool,
}
