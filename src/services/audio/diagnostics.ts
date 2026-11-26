/**
 * The audio engine's flight recorder.
 *
 * The console trace is behind a flag; the ring is always on. It exists
 * because the failure that matters here is one the user escapes by restarting
 * the app, and the restart is what destroys the evidence — so the record has
 * to be in memory, cheap, and copyable from Settings while the app is still
 * in the broken state.
 */

// Verbose console tracing, gated so it never spams release builds. Enable with
// `localStorage.setItem('stack:audioDebug','1')` and reload. The traces show
// whether the context was created inside a user gesture and whether it ever
// reaches 'running' — the two things WebKit gets wrong.
export function audioDebugEnabled(): boolean {
  try {
    return localStorage.getItem('stack:audioDebug') === '1';
  } catch {
    return false;
  }
}

// The console trace stays behind the flag, but the ring below is always on.
// It costs a few hundred small objects and it is the only record that survives
// the failure worth recording: the engine dies, the user restarts the app to
// get sound back, and the restart is what loses the evidence. Audio
// diagnostics can copy it out.
const LOG_RING_MAX = 300;
const logRing: Array<{ t: number; event: string; data?: Record<string, unknown> }> = [];

export function alog(event: string, data?: Record<string, unknown>): void {
  logRing.push({ t: Math.round(performance.now()), event, data });
  if (logRing.length > LOG_RING_MAX) logRing.shift();
  if (!audioDebugEnabled()) return;
  // eslint-disable-next-line no-console
  console.info(`[audio] ${event}`, data ?? '');
}

/** The ring, oldest first, as plain text. `header` is prepended verbatim. */
export function formatLog(header: string): string {
  return (
    header +
    logRing
      .map((e) => `${e.t} ${e.event}${e.data ? ' ' + JSON.stringify(e.data) : ''}`)
      .join('\n')
  );
}

/**
 * Empty the ring.
 *
 * A session that has been open for a day carries thousands of events, of which
 * the handful describing the failure are buried in the middle — and the ring
 * is capped, so the oldest of them fall out while the newest are still routine
 * browsing. Clearing before reproducing something deliberately is the
 * difference between a log that shows the fault and a log that shows what came
 * after it.
 */
export function clearLog(): void {
  logRing.length = 0;
}

/** How many events the ring is holding. */
export function logLength(): number {
  return logRing.length;
}
