/**
 * The parts of this engine that exist because of WKWebView.
 *
 * Stack runs on WebKit on macOS, and WebKit's Web Audio differs from
 * Chromium's in ways that are not optional to handle: a context has a state
 * the DOM type union does not list, a resume can park forever instead of
 * rejecting, and a context can report itself as running while its clock is
 * stopped. Everything here is about telling those apart.
 */

import { END_OF_BUFFER_EPSILON } from './constants';

/** Whether the browser reports an active user gesture right now (WebKit autoplay gate). */
export function userActivationActive(): boolean | null {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } })
    .userActivation;
  return ua ? ua.isActive : null;
}

// ─── Output preferences ──────────────────────────────────────────────────────
const SAMPLE_RATE_KEY = 'stack:audioSampleRate';
const BUFFER_KEY = 'stack:audioBufferSamples';
const SINK_ID_KEY = 'stack:audioSinkId';

/**
 * Forget any output preference stored by an older build.
 *
 * These were settings once — output device, sample rate, buffer length. They
 * are gone, so a value left behind would be in force with nothing in the
 * interface admitting it existed, which is the worst of both.
 */
export function clearOutputPrefs(): void {
  try {
    localStorage.removeItem(SAMPLE_RATE_KEY);
    localStorage.removeItem(BUFFER_KEY);
    localStorage.removeItem(SINK_ID_KEY);
  } catch {
    /* ignore */
  }
}

clearOutputPrefs();

/**
 * True only when the context will actually produce sound. WebKit adds an
 * 'interrupted' state that the DOM `AudioContextState` union doesn't list,
 * so compare as a plain string rather than against the union.
 */
export function isRunning(ctx: AudioContext): boolean {
  return (ctx.state as string) === 'running';
}

/**
 * Where in the buffer to actually start.
 *
 * An offset at or past the end starts a source that produces no sound and ends
 * immediately. That used to be reachable by ordinary use: the play button maps
 * to stop/resume, each stop recorded the playhead, and on a short one-shot a
 * few quick presses walked the resume point to the end of the file — after
 * which every press was silent until another sample was selected (issue #12).
 * Treat it as "play it again" instead, which is what the button means.
 */
export function startOffsetFor(offsetSec: number, duration: number): number {
  if (!Number.isFinite(offsetSec) || offsetSec <= 0) return 0;
  if (offsetSec >= duration - END_OF_BUFFER_EPSILON) return 0;
  return Math.min(offsetSec, duration);
}

/**
 * Settle with `p`, or give up after `ms`. Resolves true if `p` settled in
 * time, false if it is still pending — see RESUME_TIMEOUT_MS for why every
 * await of a WebKit audio promise goes through this.
 */
export function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer = 0;
  return Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = window.setTimeout(() => resolve(false), ms);
    }),
  ]).then((settled) => {
    window.clearTimeout(timer);
    return settled;
  });
}
