import { useQuery } from '@tanstack/react-query';
import { type RefObject, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { assetService } from '../services/assetService';
import { assetQueryKeys } from './useAssets';
import { subscribeToTheme } from './useThemeEpoch';
import { waitForScrollSettled } from './useScrollActivity';

/**
 * A waveform that is not cached yet makes the backend decode the file to build
 * one, so a fast flick through an un-analysed folder would queue one decode
 * per row it passed. The wait lives inside the query function rather than on
 * `enabled`, so no component subscribes to the scroll state and nothing
 * re-renders when it changes. A waveform react-query already holds is returned
 * instantly either way — only a genuine fetch waits.
 */
export function useWaveformData(id: string | null) {
  return useQuery({
    queryKey: id ? assetQueryKeys.waveform(id) : ['waveform', 'null'],
    queryFn: async () => {
      if (!id) return [];
      await waitForScrollSettled();
      return assetService.getWaveform(id);
    },
    enabled: Boolean(id),
    staleTime: Infinity,
  });
}

/* ─── Why this file is written the way it is ──────────────────────────────
 *
 * Every row in the list owns a waveform canvas, so everything here runs
 * dozens of times per scroll — once per row that mounts. Three things in the
 * original version were cheap on their own and ruinous at that multiplier,
 * and all three are the kind of cost that shows up as a list that "feels
 * clippy" rather than as anything you can point at:
 *
 *   1. `getBoundingClientRect()` per draw forced a layout, and
 *      `getComputedStyle(documentElement)` per draw forced a style recalc.
 *      Interleaved with React mounting the next row, that is textbook layout
 *      thrashing: the browser cannot batch any of it.
 *   2. `fillStyle` was assigned inside the per-pixel loop. Assigning a colour
 *      string re-parses it every time, so a 300px row cost 300 parses — and
 *      each row was drawn three times on mount (eagerly, from the
 *      ResizeObserver, and from the data effect).
 *   3. One ResizeObserver was constructed per row.
 *
 * So: colours are cached until the theme changes, size comes from a single
 * shared ResizeObserver's `contentRect` (which costs no layout because the
 * observer already measured), and the draw sets two colours total.
 *
 * What is NOT deferred is the drawing. Holding it back until the list settled
 * was tried and is wrong: a canvas is blank until something draws into it, so
 * every row that mounted during a fling arrived empty and filled in a moment
 * later — which reads as the rows flashing, and defeats the entire purpose of
 * overscan. The draw happens in a layout effect, before paint, seeded with the
 * width already known for that row height. Only the *fetch* behind it waits,
 * because only the fetch is expensive.
 * ─────────────────────────────────────────────────────────────────────── */

type Palette = { played: string; idle: string; placeholder: string };

let palette: Palette | null = null;

function colors(): Palette {
  if (!palette) {
    const cs = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) =>
      (cs.getPropertyValue(name) || fallback).trim();
    palette = {
      played: `rgb(${read('--stack-fire', '242 97 63')})`,
      idle: `rgb(${read('--gray-500', '85 85 85')})`,
      placeholder: `rgb(${read('--gray-700', '36 36 36')})`,
    };
  }
  return palette;
}

subscribeToTheme(() => {
  palette = null;
});

// One observer for every canvas in the app. N observers for N rows is itself
// a per-mount cost, and the callback hands us `contentRect` — the size we
// need, already measured, without asking the layout engine again.
type SizeHandler = (width: number, height: number) => void;
const sizeHandlers = new WeakMap<Element, SizeHandler>();
let sharedObserver: ResizeObserver | null = null;

function observeSize(el: Element, handler: SizeHandler): () => void {
  if (!sharedObserver) {
    sharedObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) sizeHandlers.get(entry.target)?.(width, height);
      }
    });
  }
  sizeHandlers.set(el, handler);
  sharedObserver.observe(el);
  return () => {
    sizeHandlers.delete(el);
    sharedObserver?.unobserve(el);
  };
}

// Reused across every draw so a scroll allocates nothing.
let scratch = new Float32Array(0);

// Last width seen at a given row height. Every row in a list is the same
// width, so a canvas that has just mounted can be drawn at the right size
// immediately instead of waiting a frame for its observer — which is the
// difference between a row scrolling into view already filled and flashing
// blank first. The observer corrects it if the guess is ever wrong.
const widthByHeight = new Map<number, number>();

function drawWaveform(
  canvas: HTMLCanvasElement,
  data: number[] | null | undefined,
  progress: number,
  cssWidth: number,
  cssHeight: number
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(cssWidth * dpr);
  const height = Math.round(cssHeight * dpr);
  if (width < 2 || height < 2) return;

  if (canvas.width !== width || canvas.height !== height) {
    // Assigning either dimension also clears the canvas.
    canvas.width = width;
    canvas.height = height;
  } else {
    ctx.clearRect(0, 0, width, height);
  }

  const { played, idle, placeholder } = colors();

  if (!data || data.length === 0) {
    ctx.fillStyle = placeholder;
    ctx.fillRect(0, Math.round(height / 2) - 1, width, 2);
    return;
  }

  const mid = height / 2;
  const count = data.length;
  const progressX = progress * width;

  if (scratch.length < width) scratch = new Float32Array(width);

  // Peak-hold when there are more samples than pixels, linear interpolation
  // when there are fewer — either way one 1px column per output pixel, so the
  // envelope is continuous rather than chunky at any row width.
  const samplesPerPx = count / width;
  if (samplesPerPx >= 1) {
    for (let x = 0; x < width; x++) {
      const a = Math.floor(x * samplesPerPx);
      const b = Math.min(count, Math.floor((x + 1) * samplesPerPx));
      let peak = 0;
      for (let i = a; i < b; i++) {
        const v = data[i];
        if (v > peak) peak = v;
      }
      scratch[x] = Math.min(1, Math.max(0, peak));
    }
  } else {
    const lastIdx = count - 1;
    for (let x = 0; x < width; x++) {
      const t = (x / width) * lastIdx;
      const i = Math.floor(t);
      const frac = t - i;
      const a = data[i] ?? 0;
      const b = data[Math.min(lastIdx, i + 1)] ?? a;
      scratch[x] = Math.min(1, Math.max(0, a + (b - a) * frac));
    }
  }

  // Two passes, two fillStyle assignments. The played portion is drawn over
  // the idle bars rather than beside them: the geometry is identical and the
  // colour is opaque, so the overdraw is exact.
  const column = (x: number) => {
    const h = Math.max(1, scratch[x] * mid * 0.92 * 2);
    ctx.fillRect(x, mid - h / 2, 1, h);
  };

  ctx.fillStyle = idle;
  for (let x = 0; x < width; x++) column(x);

  if (progressX > 0) {
    ctx.fillStyle = played;
    const end = Math.min(width, Math.ceil(progressX));
    for (let x = 0; x < end; x++) column(x);
  }
}

export function useWaveformCanvas(
  canvasRef: RefObject<HTMLCanvasElement>,
  data: number[] | null | undefined,
  progress: number,
  heightHint?: number
) {
  // Always keep latest values accessible to the observer callback
  const latestRef = useRef({ data, progress });
  latestRef.current = { data, progress };

  // Last size the shared observer reported, so a draw never has to measure.
  // Seeded from the cache above so the very first draw can happen on mount.
  const sizeRef = useRef({
    width: heightHint ? (widthByHeight.get(heightHint) ?? 0) : 0,
    height: heightHint ?? 0,
  });

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const { width, height } = sizeRef.current;
    if (!canvas || width === 0 || height === 0) return;
    drawWaveform(canvas, latestRef.current.data, latestRef.current.progress, width, height);
  }, [canvasRef]);

  // Draw as soon as the element exists, before the browser paints. Deferring
  // this to the observer — or worse, until the list stopped scrolling — is
  // what made rows flash: a canvas is blank until something draws into it, so
  // every row mounted during a fling arrived empty and filled in afterwards,
  // which is precisely what overscan exists to prevent. The draw itself is
  // cheap now; it is the fetch behind it that has to wait, not this.
  useLayoutEffect(() => {
    redraw();
  }, [data, progress, redraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const unobserve = observeSize(canvas, (width, height) => {
      const prev = sizeRef.current;
      sizeRef.current = { width, height };
      widthByHeight.set(Math.round(height), width);
      if (prev.width !== width || prev.height !== height) redraw();
    });

    // Repaint when the user toggles dark/light so colors flip with the rest
    // of the UI — the palette cache is cleared by its own subscription.
    const unsubscribeTheme = subscribeToTheme(redraw);

    return () => {
      unobserve();
      unsubscribeTheme();
    };
  }, [canvasRef, redraw]);
}
