/**
 * Interface scale.
 *
 * The whole window scales, not just type: a bigger font inside the same 42px
 * artwork and the same 160px folder column is a worse layout, not a larger
 * one. So this drives the webview's own zoom, which is the same mechanism a
 * browser's Cmd +/- uses — every px in the stylesheet, including Tailwind's
 * arbitrary `text-[11px]` values, scales with it.
 *
 * The factor is kept in localStorage rather than in the settings row, for the
 * same reason the audio device is: it describes this display, and a value
 * picked on a 32" monitor is wrong on a laptop the moment the database is
 * carried over.
 *
 * Anything that converts between screen and viewport coordinates has to divide
 * by this — `getBoundingClientRect()` reports zoomed CSS pixels while the OS
 * reports real ones. `dragService` is the one place that does.
 */
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

const ZOOM_KEY = 'stack:zoom';

export const MIN_ZOOM = 0.7;
export const MAX_ZOOM = 2;
export const DEFAULT_ZOOM = 1;

/** The rungs Cmd +/- steps through — the ladder browsers use, trimmed. */
export const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function clamp(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

let current = DEFAULT_ZOOM;

export function readZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_KEY);
    return raw ? clamp(Number(raw)) : DEFAULT_ZOOM;
  } catch {
    return DEFAULT_ZOOM;
  }
}

/** The factor in force right now. Synchronous — coordinate math needs it. */
export function currentZoom(): number {
  return current;
}

export function applyZoom(factor: number): number {
  const next = clamp(factor);
  current = next;
  try {
    if (next === DEFAULT_ZOOM) localStorage.removeItem(ZOOM_KEY);
    else localStorage.setItem(ZOOM_KEY, String(next));
  } catch {
    /* private mode — the zoom still applies, it just won't be remembered */
  }
  getCurrentWebviewWindow()
    .setZoom(next)
    .catch(() => {
      // Not a Tauri webview (browser mode over the embedded HTTP server), or
      // the platform refused. The CSS property is WebKit/Blink-supported and
      // scales the same way; it is the fallback, not the primary, because it
      // reflows a little differently around fixed positioning.
      document.documentElement.style.zoom = String(next);
    });
  window.dispatchEvent(new CustomEvent('stack:zoom-changed', { detail: { zoom: next } }));
  return next;
}

/** Restore the saved factor. Called once, at startup. */
export function initZoom(): number {
  return applyZoom(readZoom());
}

function step(direction: 1 | -1): number {
  const ladder = direction === 1 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  const next = ladder.find((z) => (direction === 1 ? z > current + 1e-6 : z < current - 1e-6));
  return applyZoom(next ?? current);
}

export const zoomIn = () => step(1);
export const zoomOut = () => step(-1);
export const zoomReset = () => applyZoom(DEFAULT_ZOOM);
