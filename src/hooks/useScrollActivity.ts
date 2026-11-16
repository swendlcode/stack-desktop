/**
 * Is a list being scrolled right now?
 *
 * This exists to keep work off the wheel. Every visible row asks for its
 * waveform, and a waveform that is not cached yet makes the backend decode the
 * file to build one — so a fast flick through an un-analysed folder queues
 * hundreds of decodes behind the scroll, and the list stutters exactly when it
 * should glide.
 *
 * The flag lets that work wait until just after the user stops, which is when
 * nobody is looking at it. It is a module-level store rather than context
 * because it is read from inside virtualised rows and from the canvas draw
 * path, neither of which should have to re-render to find out whether the
 * list is moving.
 */
const SETTLE_MS = 140;

let scrolling = false;
let timer: number | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function notifyScrollActivity(): void {
  if (!scrolling) {
    scrolling = true;
    emit();
  }
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    scrolling = false;
    emit();
  }, SETTLE_MS);
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Non-reactive read, for code that is already outside React's render path. */
export function isScrollingNow(): boolean {
  return scrolling;
}

/**
 * Resolves once the list has stopped moving.
 *
 * Deliberately not a hook. Gating a query's `enabled` on a subscribed flag
 * re-renders every waveform cell at the exact moment the scroll begins —
 * the worst possible time. Awaiting inside the query function keeps the
 * work off the wheel without any component knowing scrolling happened.
 */
export function waitForScrollSettled(): Promise<void> {
  if (!scrolling) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = subscribe(() => {
      if (scrolling) return;
      unsubscribe();
      resolve();
    });
  });
}

export const subscribeScrollActivity = subscribe;
