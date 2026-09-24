// Transport shim for `@tauri-apps/api/core`.
//
// Vite aliases `@tauri-apps/api/core` to this module (see vite.config.ts), so
// every existing `import { invoke, convertFileSrc } from '@tauri-apps/api/core'`
// transparently routes through here — no source changes needed.
//
// In the desktop app (Tauri webview) calls go through the real Tauri IPC.
// In a plain browser tab they fall back to the embedded HTTP server that the
// desktop process exposes (same-origin `/__ipc` + `/__media`).
import { core } from '@tauri-apps/api';

/** True inside the Tauri webview (desktop), false in a normal browser tab. */
export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Re-export the real Channel so plugins that import it from `@tauri-apps/api/core`
// (e.g. @crabnebula/tauri-plugin-drag) resolve through this aliased shim. Channel
// is desktop-only; the browser fallback never exercises those plugins.
export const Channel = core.Channel;

// Same reasoning for `Resource`, which @tauri-apps/plugin-updater extends for
// its Update handle. Desktop-only: the browser fallback never runs the updater.
export const Resource = core.Resource;

// ─── Access token ────────────────────────────────────────────────────────────
// The server requires a token on /__ipc, /__media and /__events whenever it is
// bound to the local network. The URL shown in Settings carries it as
// `?token=…`; we capture it on first load, remember it, and strip it back out
// of the address bar so it isn't left sitting in history or a shared link.
//
// The server also hands the browser a `stack_token` cookie on that first load,
// so plain <img>/<audio> requests work even if localStorage is unavailable.

const TOKEN_KEY = 'stack:webToken';

function captureToken(): string | null {
  if (typeof window === 'undefined') return null;
  let fromUrl: string | null = null;
  try {
    fromUrl = new URLSearchParams(window.location.search).get('token');
  } catch {
    /* malformed query string */
  }
  if (fromUrl) {
    try {
      window.localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      /* private mode — the cookie still covers this session */
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch {
      /* history unavailable — harmless */
    }
    return fromUrl;
  }
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let webToken: string | null = isTauri ? null : captureToken();

/** The token this browser session authenticates with, if any. */
export function getWebToken(): string | null {
  return webToken;
}

/**
 * Build a same-origin bridge URL with the token attached.
 *
 * Always compose through URLSearchParams: `/__media` already carries `?path=`,
 * and hand-concatenating a second `?` silently folds the extra params into the
 * previous value (this is exactly how the `?v=` cache-buster once 404'd every
 * pack cover).
 */
export function bridgeUrl(path: string, params?: Record<string, string>): string {
  const qs = new URLSearchParams(params ?? {});
  if (webToken) qs.set('token', webToken);
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

async function httpInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (webToken) headers.authorization = `Bearer ${webToken}`;
  const res = await fetch(bridgeUrl(`/__ipc/${cmd}`), {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        'Not authorised. Reopen the link from Stack › Settings › Web access.',
      );
    }
    // Mirror Tauri's invoke(): reject with the backend error payload.
    throw body && typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error: unknown }).error
      : body ?? new Error(`ipc ${cmd} failed (${res.status})`);
  }
  return body as T;
}

export function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return isTauri ? core.invoke<T>(cmd, args) : httpInvoke<T>(cmd, args);
}

export function convertFileSrc(filePath: string, protocol = 'asset'): string {
  return isTauri
    ? core.convertFileSrc(filePath, protocol)
    : bridgeUrl('/__media', { path: filePath });
}
