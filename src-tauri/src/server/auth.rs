//! Token authentication for the embedded HTTP server.
//!
//! A single random token is generated on first run and kept in the app data
//! dir, so the URL printed in Settings stays valid across launches. Every
//! `/__ipc`, `/__media` and `/__events` request must present it once the server
//! is bound to anything other than loopback.
//!
//! Three ways to present it, in order of precedence:
//!   1. `Authorization: Bearer <token>` (or `X-Stack-Token: <token>`)
//!   2. `?token=<token>` — used by media/SSE URLs, which cannot set headers
//!   3. the `stack_token` cookie, which the static handler sets the first time
//!      a page is opened with a valid `?token=`, so a normal browser session
//!      just works afterwards.

use std::path::Path;
use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use once_cell::sync::OnceCell;
use uuid::Uuid;

/// Cookie the browser keeps once it has opened a URL carrying `?token=…`.
pub const COOKIE_NAME: &str = "stack_token";
/// Query parameter carrying the token.
pub const QUERY_KEY: &str = "token";
/// One year — the token itself does not expire.
const COOKIE_MAX_AGE: u32 = 31_536_000;

static TOKEN: OnceCell<Arc<str>> = OnceCell::new();

/// Load the persisted access token, generating one on first run. Idempotent.
pub fn init(data_dir: &Path) -> Arc<str> {
    TOKEN
        .get_or_init(|| read_or_create(data_dir).into())
        .clone()
}

/// The current token. Empty only if `init` was never called.
pub fn token() -> Arc<str> {
    TOKEN.get().cloned().unwrap_or_else(|| Arc::from(""))
}

fn read_or_create(data_dir: &Path) -> String {
    let path = data_dir.join("web_access_token");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim().to_string();
        if existing.len() >= 32 {
            return existing;
        }
    }
    // Two v4 UUIDs = 244 bits of OS entropy, rendered as 64 hex chars.
    let fresh = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let _ = std::fs::create_dir_all(data_dir);
    if std::fs::write(&path, &fresh).is_ok() {
        restrict(&path);
    }
    fresh
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}

/// Router state for the auth layer.
#[derive(Clone)]
pub struct Auth {
    pub token: Arc<str>,
    /// `false` while bound to loopback only — local requests stay friction-free.
    /// Always `true` when bound to `0.0.0.0`.
    pub required: bool,
}

/// Length-independent comparison so a wrong token leaks no timing signal.
pub fn matches(candidate: &str, expected: &str) -> bool {
    if candidate.len() != expected.len() || expected.is_empty() {
        return false;
    }
    candidate
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Pull the `token` value out of a raw query string.
pub fn query_token(query: &str) -> Option<String> {
    form_urlencoded_pairs(query).find_map(|(k, v)| (k == QUERY_KEY).then_some(v))
}

/// Minimal `key=value&…` splitter with percent/plus decoding of the value.
fn form_urlencoded_pairs(query: &str) -> impl Iterator<Item = (String, String)> + '_ {
    query.split('&').filter_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        Some((k.to_string(), percent_decode(v)))
    })
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn cookie_token(raw: &str) -> Option<String> {
    raw.split(';').find_map(|c| {
        let (k, v) = c.trim().split_once('=')?;
        (k == COOKIE_NAME).then(|| v.to_string())
    })
}

/// The token the request presents, if any.
fn presented(req: &Request) -> Option<String> {
    let headers = req.headers();
    if let Some(v) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        let bearer = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer "));
        if let Some(t) = bearer {
            return Some(t.trim().to_string());
        }
    }
    if let Some(v) = headers.get("x-stack-token").and_then(|v| v.to_str().ok()) {
        return Some(v.trim().to_string());
    }
    if let Some(t) = req.uri().query().and_then(query_token) {
        return Some(t);
    }
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(cookie_token)
}

/// Reject every unauthenticated request once a token is required.
pub async fn guard(State(auth): State<Auth>, req: Request, next: Next) -> Response {
    if !auth.required {
        return next.run(req).await;
    }
    match presented(&req) {
        Some(t) if matches(&t, &auth.token) => next.run(req).await,
        _ => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "unauthorized: open the URL shown in Stack › Settings › Web access"
            })),
        )
            .into_response(),
    }
}

/// `Set-Cookie` value pinning the token to this browser.
pub fn cookie_value(token: &str) -> String {
    format!(
        "{}={}; Path=/; Max-Age={}; SameSite=Lax",
        COOKIE_NAME, token, COOKIE_MAX_AGE
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_is_exact() {
        assert!(matches("abc", "abc"));
        assert!(!matches("abc", "abd"));
        assert!(!matches("ab", "abc"));
        assert!(!matches("", ""));
    }

    #[test]
    fn parses_query_and_cookie() {
        assert_eq!(query_token("path=%2Ftmp%2Fa&token=xyz"), Some("xyz".into()));
        assert_eq!(query_token("path=/tmp/a"), None);
        assert_eq!(cookie_token("a=1; stack_token=xyz"), Some("xyz".into()));
        assert_eq!(cookie_token("a=1"), None);
    }
}
