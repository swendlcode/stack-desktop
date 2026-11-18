/**
 * Tuning constants for the audio engine.
 *
 * Every number here was chosen against a specific failure, and the comment on
 * each one is the failure. Changing one without reading it is how a fixed bug
 * comes back.
 */

// How many tracks to pre-decode around the current selection
export const PREFETCH_RADIUS = 3;
// Max decoded buffers to keep in memory (~5–10 MB each for a typical sample)
export const CACHE_MAX = 20;
// Extra output gain for sample preview playback so perceived loudness is higher.
export const SAMPLE_GAIN_BOOST = 2;
// How long to watch the context clock before calling it stalled. Long enough to
// clear a render quantum at any sample rate, short enough to stay invisible.
export const CLOCK_PROBE_MS = 120;
// Starting a source this close to the end of the buffer is silence in practice.
export const END_OF_BUFFER_EPSILON = 0.01;
// How hard to try resuming before declaring a context wedged. WebKit un-
// interrupts asynchronously after the window comes back, so the first resume
// can resolve into a state that is still not 'running'.
export const RESUME_ATTEMPTS = 5;
export const RESUME_RETRY_MS = 60;
// How stale the last good clock sample may be before a synchronous reader
// treats the context as stalled. Comfortably longer than a render quantum at
// any sample rate, short enough that a click never trusts a dead context.
export const CLOCK_STALL_MS = 250;
// How long after starting a source to confirm the clock actually moved.
export const START_VERIFY_MS = 80;
// How long to wait on a resume() before treating it as ineffective.
//
// WebKit does not reject a resume it cannot grant: it parks the promise and
// resolves it only if the context ever reaches 'running', which after a Space
// switch can be never. Every `await` behind one of those then waits for the
// rest of the session, and because those awaits sit inside the single-flight
// recovery guards, the guards never clear either — the engine is dead until
// the app is restarted, which is exactly the report. Nothing in this file may
// await a WebKit audio promise without a bound.
export const RESUME_TIMEOUT_MS = 300;
// Backstop for the single-flight guards themselves, in case something else in
// the chain parks. A guard that outlives this is logged and released.
export const GUARD_WATCHDOG_MS = 3000;

// A start slower than this is a bug, not a preference. When one happens the
// event ring is written to `<app data>/audio-log.txt`, because the failure is
// one the user escapes by restarting — which is exactly what destroys the
// evidence.
export const SLOW_START_MS = 150;
// At most one dump per episode. Fifty clicks in a bad minute should not write
// fifty logs.
export const LOG_DUMP_THROTTLE_MS = 10000;
// A request that never becomes audible at all is the worst failure and was
// the only one that left no trace: the slow-start dump needs a start to
// measure, and silence never produces one. If nothing has made a sound this
// long after a click, the ring is written anyway.
export const NO_SOUND_MS = 700;
// How far back a start may be attributed to the press that caused it. Longer
// than any plausible queue, shorter than the gap between two deliberate
// clicks, so a start that was not triggered by a press is not blamed on an
// unrelated one.
export const INPUT_ATTRIBUTION_MS = 1000;
