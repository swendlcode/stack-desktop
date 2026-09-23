import { useSyncExternalStore } from 'react';

/**
 * One shared watcher for theme changes.
 *
 * Canvases (waveform, MIDI roll) read their colours from CSS variables at
 * draw time, so they must repaint when the theme or accent changes. Each
 * canvas used to install its own MutationObserver on <html>, which meant
 * roughly one observer per visible row. This is a single observer with a
 * subscriber list instead.
 */
let epoch = 0;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function start() {
  if (observer || typeof window === 'undefined') return;
  observer = new MutationObserver(() => {
    epoch += 1;
    listeners.forEach((fn) => fn());
  });
  observer.observe(document.documentElement, {
    attributes: true,
    // 'style' covers the inline accent overrides written by applyAccent().
    attributeFilter: ['data-theme', 'style'],
  });
}

/** Imperative subscription for non-React draw loops. Returns an unsubscribe. */
export function subscribeToTheme(onChange: () => void): () => void {
  start();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Counter that increments on every theme change — use as an effect dep. */
export function useThemeEpoch(): number {
  return useSyncExternalStore(
    (cb) => subscribeToTheme(cb),
    () => epoch,
    () => 0,
  );
}
