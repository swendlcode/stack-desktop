/**
 * When the user last asked for something.
 *
 * The engine times a start from `noteRequest`, which runs inside the play
 * path — so it measures the engine, not the wait. Everything between the
 * press and that line is invisible to it: the event queue, React committing a
 * re-render, a query settling, a waveform being drawn. A start can be logged
 * as 0ms while the press that caused it happened a third of a second earlier,
 * which is exactly long enough to be felt and complained about.
 *
 * This is the other end of the measurement. One listener each for pointer and
 * key, in the capture phase so nothing can stop them, recording the instant
 * the gesture arrived.
 */

let lastInputAt = 0;

function mark(): void {
  lastInputAt = performance.now();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', mark, { capture: true, passive: true });
  window.addEventListener('keydown', mark, { capture: true, passive: true });
}

/** The timestamp of the most recent press. */
export function lastInput(): number {
  return lastInputAt;
}
