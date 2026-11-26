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
// And a ceiling on what they weigh, because the count says nothing about the
// cost. A decoded buffer is Float32 per channel: a five-and-a-half minute
// stereo stem is 117.7MB in memory from an 88MB file, and a folder of 73 of
// them let the count cap authorise 2.3GB. Eight were decoded in one pass of
// the arrow key in the recorded capture.
export const CACHE_MAX_BYTES = 512 * 1024 * 1024;
// The longest sample worth decoding on spec. Clicking one still decodes it —
// the user asked. Reading six neighbours off disk at 88MB each because the
// selection passed nearby is what stalled the main thread for 148ms a press
// and put the sound a row behind the list: eight `start:mismatch` in a row,
// every one of them a sample the user could hear but was not looking at.
export const PREFETCH_MAX_SECONDS = 30;
// How many speculative decodes may be in flight at once.
//
// `prefetchAround` used to start every neighbour immediately: a radius of
// three is seven whole-file reads fired in parallel, and every arrow press
// fired another seven. Each one is a multi-megabyte fetch over the asset
// protocol plus a decodeAudioData, so the sample the user actually pressed
// was queued behind a crowd of samples nobody had asked for — competing for
// the webview's connection pool and for the main thread at the exact moment
// it needed both. That is the delay between pressing a sample and hearing
// it, and it is why the app felt sluggish next to one that does no
// speculative decoding at all.
//
// Two keeps the cache warming usefully ahead of the selection while leaving
// the machine enough room to answer a press immediately. A decode the user
// has actually asked for ignores this limit entirely.
export const PREFETCH_CONCURRENCY = 2;
// Extra output gain for sample preview playback so perceived loudness is higher.
export const SAMPLE_GAIN_BOOST = 2;
// How long to watch the context clock before calling it stalled. Long enough to
// clear a render quantum at any sample rate, short enough to stay invisible.
export const CLOCK_PROBE_MS = 120;
// How far the clock may drift from wall time and still count as alive.
//
// "Did the clock move" is not the same question as "is the clock real", and
// the difference is a whole night of silence. After the output device changed
// while the window was hidden, a context sat in 'running' with a clock that
// advanced 533 seconds across 11 hours of wall time and then caught up in
// bursts: 973 seconds inside a single 121ms probe, 15,000 inside two seconds.
// Every one of those bursts satisfied `currentTime > before`, so recovery was
// skipped on every refocus and the context was never replaced. A clock running
// at 1.3% of real time is as dead as one running at 0%; the only honest test
// is the rate.
// How often the output is sampled while nothing is happening.
//
// Every other instrument in the engine observes at a moment the user created:
// a focus, a visibility change, a press. The degradation does not happen at
// those moments. It happens somewhere in the hours between them, and by the
// time a press goes looking, the cause is off the end of a 300-entry ring —
// three separate captures in one day each showed a clock that had come loose
// at some unknown point across an unknown number of hours. Thirty seconds is
// frequent enough to stamp the event and cheap enough to leave running.
export const HEARTBEAT_MS = 30_000;
// A baseline line every tenth tick, so a quiet log is evidence of health
// rather than evidence of nothing. Five minutes apart, which an eight-hour
// session fits inside the ring with room to spare.
export const HEARTBEAT_REPORT_EVERY = 10;
export const CLOCK_RATE_MIN = 0.5;
export const CLOCK_RATE_MAX = 2;
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

// ─── Watching the signal rather than the clock ───────────────────────────────

// Below this peak, the output carried nothing. -80 dBFS: far under anything
// audible, far over the denormals a decoded sample leaves behind. Read after
// the master gain, so it is a measurement of what left the app.
export const SILENT_PEAK = 1e-4;
// How far under the sample's own level the output has to read before it counts
// as silence. The first capture proved why an absolute floor is not enough: a
// drum fill with a quiet lead-in read 0.00136 at the tap and was right to, and
// a 53-second loop whose first 700ms are digital silence read exactly 0 and
// was reported as a failure when nothing had gone wrong. The honest question
// is not "did anything come out" but "did what should have come out, come
// out", and 26 dB down on the sample's own peak is not a quiet intro.
export const SILENT_SHORTFALL = 20;
// When to read the output tap after a start. Several reads rather than one: a
// one-shot can be over before a single late read, and a pad with a slow attack
// is still under the floor at an early one. The peak across the window is the
// answer.
export const WITNESS_SAMPLES_MS = [60, 120, 220, 380, 600];
// How long the output may sit idle before coming back to the window re-arms
// it. A context that has rendered nothing for a while takes most of a second
// to produce its first sound again — 662, 669 and 909ms in the recorded logs,
// every one of them on a context that was running with its clock advancing.
export const REARM_IDLE_MS = 2000;
