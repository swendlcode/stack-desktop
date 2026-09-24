use serde::{Deserialize, Serialize};

/// Everything the Settings UI needs to show — and hand out — browser access.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebAccessInfo {
    /// Serving is switched on in settings.
    pub enabled: bool,
    /// Bound to `0.0.0.0` (reachable from the local network) rather than loopback.
    pub lan: bool,
    /// Port the server is configured to listen on.
    pub port: u16,
    /// Port actually bound right now, when it differs (bind failure leaves `None`).
    pub bound_port: Option<u16>,
    /// A server is listening for the current configuration.
    pub running: bool,
    /// Access token. Required on every request while `lan` is on.
    pub token: String,
    /// Ready-to-open URL on this machine, token included.
    pub local_url: String,
    /// Same, on the machine's LAN address — `None` if no LAN address was found.
    pub lan_url: Option<String>,
    /// The detected LAN address, for display.
    pub lan_ip: Option<String>,
}
