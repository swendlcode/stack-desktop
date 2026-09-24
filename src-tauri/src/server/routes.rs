//! The four HTTP endpoints. `/__ipc`, `/__media` and `/__events` sit behind
//! the auth layer wired up in `mod.rs`; the static fallback does not, so the UI
//! shell always loads and can explain a missing token.

use std::path::PathBuf;

use axum::{
    body::Body,
    extract::{Query, State as AxState},
    http::{header, HeaderValue, Method, Request, StatusCode, Uri},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use futures::Stream;
use serde::Deserialize;
use serde_json::Value;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use super::{auth, ipc, Ctx};

pub(super) async fn ipc_handler(
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
pub(super) struct MediaQuery {
    pub path: String,
}

pub(super) async fn media_handler(
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

pub(super) async fn events_handler(
    AxState(ctx): AxState<Ctx>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let rx = ctx.events.subscribe();
    let mut stop = ctx.shutdown.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|msg| match msg {
        Ok(data) => Some(Ok(Event::default().data(data))),
        Err(_) => None, // dropped frames on lag — client refetches on reconnect
    });
    // Fully qualified: `filter_map` comes from tokio-stream's StreamExt,
    // `take_until` only from futures' — importing both would be ambiguous.
    let stream = futures::StreamExt::take_until(stream, async move {
        let _ = stop.recv().await;
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Serve the embedded frontend bundle, falling back to index.html for SPA routes.
///
/// A valid `?token=` on any page load is exchanged for the `stack_token` cookie,
/// so opening the printed URL once is enough for the rest of the session.
pub(super) async fn static_handler(AxState(ctx): AxState<Ctx>, uri: Uri) -> Response {
    let resolver = ctx.app.asset_resolver();
    let raw = uri.path().trim_start_matches('/');
    let path = if raw.is_empty() { "index.html" } else { raw };

    let asset = resolver
        .get(path.to_string())
        .or_else(|| resolver.get("index.html".to_string()));
    let Some(asset) = asset else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };

    let mut res = serve_asset(asset.bytes, &asset.mime_type);
    let presented = uri.query().and_then(auth::query_token);
    if presented
        .as_deref()
        .is_some_and(|t| auth::matches(t, &ctx.auth.token))
    {
        if let Ok(v) = HeaderValue::from_str(&auth::cookie_value(&ctx.auth.token)) {
            res.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    res
}

fn serve_asset(bytes: Vec<u8>, mime: &str) -> Response {
    let mut res = Response::new(Body::from(bytes));
    if let Ok(v) = HeaderValue::from_str(mime) {
        res.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    res
}
