//! Embedded localhost HTTP server.
//!
//! While the desktop app runs, this exposes the *same* React UI (and the same
//! backend commands) on `http://localhost:<port>` so it can be opened in any
//! browser. The browser talks to three same-origin endpoints:
//!   - `POST /__ipc/:cmd`  → dispatches to the existing Tauri commands
//!   - `GET  /__media?path=…` → streams a local file (audio, cover art) with
//!     HTTP Range support
//!   - `GET  /__events`    → Server-Sent Events bridging Tauri's `stack://…` bus
//!
//! Everything else is served from the embedded frontend bundle (SPA fallback).

mod ipc;

use std::net::SocketAddr;
use std::path::PathBuf;

use axum::{
    body::Body,
    extract::{Query, State as AxState},
    http::{header, HeaderValue, Method, Request, StatusCode, Uri},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures::Stream;
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Listener};
use tokio::sync::broadcast;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};
use tower::ServiceExt;
use tower_http::services::ServeFile;

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

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
    events: broadcast::Sender<String>,
}

/// Start the server in the background, bound to loopback only.
pub fn start(app: AppHandle, port: u16) {
    let (tx, _rx) = broadcast::channel::<String>(512);

    // Bridge the Tauri event bus → broadcast channel consumed by SSE clients.
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

    let ctx = Ctx { app, events: tx };
    let router = Router::new()
        .route("/__ipc/:cmd", post(ipc_handler))
        .route("/__media", get(media_handler))
        .route("/__events", get(events_handler))
        .fallback(static_handler)
        .with_state(ctx);

    tauri::async_runtime::spawn(async move {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                tracing::info!("Stack web UI available at http://localhost:{}", port);
                if let Err(e) = axum::serve(listener, router).await {
                    tracing::error!("web server stopped: {}", e);
                }
            }
            Err(e) => tracing::warn!("web server failed to bind {}: {}", addr, e),
        }
    });
}

async fn ipc_handler(
    AxState(ctx): AxState<Ctx>,
    axum::extract::Path(cmd): axum::extract::Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    let args = body.map(|Json(v)| v).unwrap_or(Value::Null);
    let args = if args.is_object() { args } else { serde_json::json!({}) };
    match ipc::dispatch(ctx.app.clone(), &cmd, args).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct MediaQuery {
    path: String,
}

async fn media_handler(
    Query(q): Query<MediaQuery>,
    headers: axum::http::HeaderMap,
) -> Response {
    let path = PathBuf::from(&q.path);
    if !path.is_file() {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    // Hand off to ServeFile, which handles content-type, Range and conditional
    // requests. We only need to forward the method + Range header.
    let mut req = Request::new(Body::empty());
    *req.method_mut() = Method::GET;
    if let Some(range) = headers.get(header::RANGE) {
        req.headers_mut().insert(header::RANGE, range.clone());
    }
    match ServeFile::new(&path).oneshot(req).await {
        Ok(res) => res.into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "read error").into_response(),
    }
}

async fn events_handler(
    AxState(ctx): AxState<Ctx>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let rx = ctx.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|msg| match msg {
        Ok(data) => Some(Ok(Event::default().data(data))),
        Err(_) => None, // dropped frames on lag — client refetches on reconnect
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Serve the embedded frontend bundle, falling back to index.html for SPA routes.
async fn static_handler(AxState(ctx): AxState<Ctx>, uri: Uri) -> Response {
    let resolver = ctx.app.asset_resolver();
    let raw = uri.path().trim_start_matches('/');
    let path = if raw.is_empty() { "index.html" } else { raw };

    if let Some(asset) = resolver.get(path.to_string()) {
        return serve_asset(asset.bytes, &asset.mime_type);
    }
    if let Some(asset) = resolver.get("index.html".to_string()) {
        return serve_asset(asset.bytes, &asset.mime_type);
    }
    (StatusCode::NOT_FOUND, "not found").into_response()
}

fn serve_asset(bytes: Vec<u8>, mime: &str) -> Response {
    let mut res = Response::new(Body::from(bytes));
    if let Ok(v) = HeaderValue::from_str(mime) {
        res.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    res
}
