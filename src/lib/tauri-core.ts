// Transport shim for `@tauri-apps/api/core`.
//
// Vite aliases `@tauri-apps/api/core` to this module (see vite.config.ts), so
// every existing `import { invoke, convertFileSrc } from '@tauri-apps/api/core'`
// transparently routes through here — no source changes needed.
//
// In the desktop app (Tauri webview) calls go through the real Tauri IPC.
// In a plain browser tab they fall back to the embedded HTTP server that the
// desktop process exposes on localhost (same-origin `/__ipc` + `/__media`).
import { core } from '@tauri-apps/api';

/** True inside the Tauri webview (desktop), false in a normal browser tab. */
export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Re-export the real Channel so plugins that import it from `@tauri-apps/api/core`
// (e.g. @crabnebula/tauri-plugin-drag) resolve through this aliased shim. Channel
// is desktop-only; the browser fallback never exercises those plugins.
export const Channel = core.Channel;

async function httpInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/__ipc/${cmd}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
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
    : `/__media?path=${encodeURIComponent(filePath)}`;
}
