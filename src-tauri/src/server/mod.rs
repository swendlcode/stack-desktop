//! Embedded HTTP server.
//!
//! While the desktop app runs, this exposes the *same* React UI (and the same
//! backend commands) on `http://<host>:<port>` so it can be opened in any
//! browser. The browser talks to three same-origin endpoints:
//!   - `POST /__ipc/:cmd`  → dispatches to the existing Tauri commands
//!   - `GET  /__media?path=…` → streams a local file (audio, cover art) with
//!     HTTP Range support
//!   - `GET  /__events`    → Server-Sent Events bridging Tauri's `stack://…` bus
//!
//! Everything else is served from the embedded frontend bundle (SPA fallback).
//!
//! Binding is opt-in per settings: loopback by default, `0.0.0.0` when the user
//! turns LAN access on. Those three endpoints sit behind [`auth::guard`], which
//! is *always* armed once the bind address leaves loopback — see `auth.rs`.

mod auth;
mod info;
mod ipc;
mod routes;

pub use info::{access_info, lan_ip};

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::{
    middleware,
    routing::{get, post},
    Router,
};
use once_cell::sync::{Lazy, OnceCell};
use parking_lot::Mutex;
use tauri::{AppHandle, Listener};
use tokio::sync::broadcast;

use crate::models::Settings;

/// Tauri events forwarded to browser clients over SSE. (Desktop-only menu /
/// overlay events are deliberately excluded.)
const FORWARDED_EVENTS: &[&str] = &[
    "stack://scan-progress",
    "stack://asset-indexed",
    "stack://reconcile-complete",
    "stack://waveform-ready",
    "stack://asset-missing",
    "stack://pack-deleted",
];

/// The three settings that decide where — and whether — we listen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WebConfig {
    pub enabled: bool,
    pub lan: bool,
    pub port: u16,
}

impl WebConfig {
    pub fn from_settings(s: &Settings) -> Self {
        Self {
            enabled: s.web_access_enabled,
            lan: s.web_access_lan,
            port: s.web_access_port,
        }
    }

    fn addr(&self) -> SocketAddr {
        let host = if self.lan {
            Ipv4Addr::UNSPECIFIED
        } else {
            Ipv4Addr::LOCALHOST
        };
        SocketAddr::new(IpAddr::V4(host), self.port)
    }
}

struct Running {
    cfg: WebConfig,
    /// Fires once to stop the accept loop *and* end every open SSE stream.
    shutdown: broadcast::Sender<()>,
    /// Set once the listener is actually bound.
    bound: Arc<Mutex<Option<u16>>>,
}

static RUNNING: Lazy<Mutex<Option<Running>>> = Lazy::new(|| Mutex::new(None));

#[derive(Clone)]
pub(super) struct Ctx {
    pub app: AppHandle,
    pub events: broadcast::Sender<String>,
    pub shutdown: broadcast::Sender<()>,
    pub auth: auth::Auth,
}

/// Bridge the Tauri event bus → broadcast channel consumed by SSE clients.
/// Registered exactly once, so restarting the server never doubles listeners.
fn event_bus(app: &AppHandle) -> broadcast::Sender<String> {
    static BUS: OnceCell<broadcast::Sender<String>> = OnceCell::new();
    BUS.get_or_init(|| {
        let (tx, _rx) = broadcast::channel::<String>(512);
        for name in FORWARDED_EVENTS {
            let tx = tx.clone();
            let name = *name;
            app.listen(name, move |event| {
                let payload = event.payload();
                let payload = if payload.is_empty() { "null" } else { payload };
                let frame = format!(
                    "{{\"event\":{},\"payload\":{}}}",
                    serde_json::to_string(name).unwrap_or_else(|_| "\"\"".into()),
                    payload,
                );
                let _ = tx.send(frame);
            });
        }
        tx
    })
    .clone()
}

/// Generate/load the access token. Call once, before [`apply`].
pub fn init_token(data_dir: &std::path::Path) {
    auth::init(data_dir);
}

/// The access token clients must present when LAN access is on.
pub fn token() -> String {
    auth::token().to_string()
}

/// The configuration currently being served, if any.
pub fn current() -> Option<(WebConfig, Option<u16>)> {
    RUNNING
        .lock()
        .as_ref()
        .map(|r| (r.cfg, *r.bound.lock()))
}

/// Start, stop or restart the server so it matches `cfg`.
pub fn apply(app: AppHandle, cfg: WebConfig) {
    let mut guard = RUNNING.lock();
    if let Some(prev) = guard.as_ref() {
        if prev.cfg == cfg && prev.bound.lock().is_some() {
            return; // already serving exactly this
        }
    }
    // Dropping the accept loop releases the socket; the same signal ends every
    // open SSE stream so a disabled/rebound server stops feeding old clients.
    if let Some(prev) = guard.take() {
        let _ = prev.shutdown.send(());
    }
    if !cfg.enabled {
        tracing::info!("web access disabled");
        return;
    }

    let (shutdown, _) = broadcast::channel::<()>(1);
    let bound: Arc<Mutex<Option<u16>>> = Arc::new(Mutex::new(None));
    let ctx = Ctx {
        app: app.clone(),
        events: event_bus(&app),
        shutdown: shutdown.clone(),
        auth: auth::Auth {
            token: auth::token(),
            // Loopback stays friction-free; anything wider demands the token.
            required: cfg.lan,
        },
    };

    let router = Router::new()
        .route("/__ipc/:cmd", post(routes::ipc_handler))
        .route("/__media", get(routes::media_handler))
        .route("/__events", get(routes::events_handler))
        // `route_layer` guards the routes above but not the fallback, so the
        // UI shell still loads and can explain itself.
        .route_layer(middleware::from_fn_with_state(ctx.auth.clone(), auth::guard))
        .fallback(routes::static_handler)
        .with_state(ctx);

    let addr = cfg.addr();
    let mut stop = shutdown.subscribe();
    let bound_slot = bound.clone();
    tauri::async_runtime::spawn(async move {
        // The previous accept loop releases its socket asynchronously, and
        // 127.0.0.1:P conflicts with 0.0.0.0:P, so a LAN toggle can briefly
        // race itself. Retry for ~1.5s before giving up.
        match bind_with_retry(addr).await {
            Ok(listener) => {
                *bound_slot.lock() = Some(addr.port());
                tracing::info!(
                    "Stack web UI listening on http://{}{}",
                    addr,
                    if cfg.lan { " (LAN, token required)" } else { "" }
                );
                tokio::select! {
                    res = axum::serve(listener, router) => {
                        if let Err(e) = res {
                            tracing::error!("web server stopped: {}", e);
                        }
                    }
                    _ = stop.recv() => tracing::info!("web server stopped"),
                }
                *bound_slot.lock() = None;
            }
            Err(e) => tracing::warn!("web server failed to bind {}: {}", addr, e),
        }
    });

    *guard = Some(Running { cfg, shutdown, bound });
}

async fn bind_with_retry(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    let mut last = None;
    for attempt in 0..10 {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => return Ok(l),
            Err(e) => {
                last = Some(e);
                if attempt < 9 {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                }
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("bind failed")))
}
