/**
 * Decoded samples, and the context that decodes them.
 *
 * Split out from the engine because decoding is not output, and treating it
 * as part of the output is what made the whole library go quiet: decodes used
 * to wait for the playback context to be running, so once that context was
 * interrupted nothing could be decoded either — not even for the HTML-element
 * fallback, which needs no context at all. The decoder here is an
 * `OfflineAudioContext`, which is never suspended, never interrupted and
 * survives a rebuild of the output.
 */

import { convertFileSrc } from '@tauri-apps/api/core';
import {
  CACHE_MAX,
  CACHE_MAX_BYTES,
  PREFETCH_CONCURRENCY,
  PREFETCH_MAX_SECONDS,
  PREFETCH_RADIUS,
} from './constants';
import { alog } from './diagnostics';

type CacheEntry = {
  buffer: AudioBuffer;
  lastUsed: number;
  /** What it weighs in memory. Float32 per channel, which is not the file size. */
  bytes: number;
};

const FALLBACK_RATE = 48000;

export class BufferCache {
  private entries = new Map<string, CacheEntry>();
  // One in-flight decode per path, so concurrent callers share it.
  private decoding = new Map<string, Promise<AudioBuffer | null>>();
  private ctx: OfflineAudioContext | null = null;
  /**
   * The rate these buffers were decoded at. An AudioBuffer is reusable in any
   * context — the platform resamples it — so this is advisory rather than a
   * correctness constraint; it only decides whether a rebuilt output at a
   * different rate is worth re-decoding for.
   */
  rate: number | null = null;
  // Paths whose bytes cannot be turned into audio. Decoding one costs a full
  // read of the file, and nothing about the answer changes on a retry.
  private readonly undecodable = new Set<string>();
  /** Total decoded bytes held. Kept in step with `entries` on every change. */
  private bytes = 0;
  /** Speculative decodes running now. Requested ones are not counted here. */
  private speculativeInFlight = 0;
  /** Speculative decodes waiting for a slot, nearest-first. */
  private pending: string[] = [];

  get size(): number {
    return this.entries.size;
  }

  /** What the cache currently weighs, for diagnostics. */
  get byteSize(): number {
    return this.bytes;
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** The decoded buffer if it is in memory, marking it as just used. */
  get(path: string): AudioBuffer | null {
    const entry = this.entries.get(path);
    if (!entry) return null;
    entry.lastUsed = Date.now();
    return entry.buffer;
  }

  /**
   * Decode now if needed, and return the buffer.
   *
   * This is the path the user is waiting on, so it ignores the speculative
   * concurrency limit and starts immediately.
   */
  async ensure(path: string): Promise<AudioBuffer | null> {
    return this.get(path) ?? this.decode(path, true);
  }

  /** Queue a background decode. No-op if cached, failed or already running. */
  prefetch(path: string): void {
    if (this.entries.has(path) || this.decoding.has(path) || this.undecodable.has(path)) return;
    if (this.speculativeInFlight >= PREFETCH_CONCURRENCY) {
      if (!this.pending.includes(path)) this.pending.push(path);
      return;
    }
    this.startSpeculative(path);
  }

  private startSpeculative(path: string): void {
    this.speculativeInFlight += 1;
    void this.decode(path).finally(() => {
      this.speculativeInFlight -= 1;
      this.drain();
    });
  }

  /** Fill freed slots from the queue, skipping anything no longer worth doing. */
  private drain(): void {
    while (this.speculativeInFlight < PREFETCH_CONCURRENCY) {
      const next = this.pending.shift();
      if (next === undefined) return;
      if (this.entries.has(next) || this.decoding.has(next) || this.undecodable.has(next)) continue;
      this.startSpeculative(next);
    }
  }

  /** Decode what the user is about to reach, in both directions. */
  prefetchAround(
    assets: { path: string; type: string; durationMs?: number | null }[],
    currentIndex: number,
  ): void {
    // Whatever was queued describes where the selection used to be. Holding
    // onto it means a fast run down the arrow key builds a backlog of
    // neighbourhoods the user has already left, and the samples next to where
    // they actually stopped go to the back of it.
    this.pending.length = 0;
    // Nearest first, and forward before back. With a concurrency limit in
    // place this order is suddenly load bearing: the loop used to run from
    // `currentIndex - RADIUS` upward, so the two slots went to the rows three
    // and two ABOVE the selection while the row the user was sitting on
    // queued behind them. Index order was harmless only while every
    // neighbour started at once.
    const order: number[] = [currentIndex];
    for (let d = 1; d <= PREFETCH_RADIUS; d += 1) order.push(currentIndex + d, currentIndex - d);
    for (const i of order) {
      if (i < 0 || i >= assets.length) continue;
      const asset = assets[i];
      if (!asset || asset.type !== 'sample') continue;
      // Speculative work has to be cheap or it is not worth doing. A stem
      // folder is the case that proves it: six neighbours at 88MB each,
      // fetched and decoded while the user is still moving, buy nothing and
      // cost the main thread the responsiveness that made the engine feel
      // instant. The one they land on still decodes on its own.
      if (asset.durationMs != null && asset.durationMs > PREFETCH_MAX_SECONDS * 1000) continue;
      this.prefetch(asset.path);
    }
  }

  clear(): void {
    this.entries.clear();
    this.decoding.clear();
    this.pending.length = 0;
    this.undecodable.clear();
    this.bytes = 0;
    this.rate = null;
  }

  /** Drop in-flight decodes only — used when the output context is replaced. */
  dropPending(): void {
    this.decoding.clear();
    this.pending.length = 0;
  }

  /** Forget specific samples, for files that have left the disk. */
  clearPaths(paths: string[]): number {
    let cleared = 0;
    for (const path of paths) {
      // Also forget that it could not be decoded: the usual reason a path is
      // cleared is that the file changed underneath, which is exactly the
      // event that makes a previous failure stale.
      this.undecodable.delete(path);
      const entry = this.entries.get(path);
      if (entry) {
        this.bytes -= entry.bytes;
        this.entries.delete(path);
        cleared += 1;
      }
    }
    return cleared;
  }

  stats(): { size: number; maxSize: number; paths: string[] } {
    return { size: this.entries.size, maxSize: CACHE_MAX, paths: [...this.entries.keys()] };
  }

  private decode(path: string, urgent = false): Promise<AudioBuffer | null> {
    const existing = this.decoding.get(path);
    if (existing) return existing;

    if (this.undecodable.has(path)) return Promise.resolve(null);

    const job = (async (): Promise<AudioBuffer | null> => {
      // Timed in two halves, because they fail for different reasons and the
      // cure is different. Reading the file is the asset protocol and the
      // disk; turning it into audio is the CPU. A log that says only that a
      // decode happened cannot tell you which of the two the user waited for,
      // and that was the whole of the evidence behind "it plays late".
      const t0 = performance.now();
      try {
        const res = await fetch(convertFileSrc(path));
        if (!res.ok) {
          alog('decode:fetch-failed', { path, status: res.status });
          return null;
        }
        const bytes = await res.arrayBuffer();
        const fetched = performance.now();
        const buffer = await this.decodeCtx().decodeAudioData(bytes);
        const decoded = performance.now();
        const weight = buffer.length * buffer.numberOfChannels * 4;
        this.evictIfNeeded(weight);
        this.entries.set(path, { buffer, lastUsed: Date.now(), bytes: weight });
        this.bytes += weight;
        alog('decode:ok', {
          path,
          duration: buffer.duration,
          urgent,
          fetchMs: Math.round(fetched - t0),
          decodeMs: Math.round(decoded - fetched),
          kb: Math.round(bytes.byteLength / 1024),
        });
        return buffer;
      } catch (err) {
        // Remember it. One corrupt file in a library is not rare — 8.5MB of
        // leading zeros with no RIFF header turned up in the first capture —
        // and without this every hover, every prefetch and every click reads
        // the whole thing off disk again to fail the same way. Seven full
        // reads of it in two and a half seconds, in a log that was supposed
        // to be about something else.
        this.undecodable.add(path);
        alog('decode:error', { path, error: String(err) });
        return null;
      } finally {
        this.decoding.delete(path);
      }
    })();

    this.decoding.set(path, job);
    return job;
  }

  private decodeCtx(): BaseAudioContext {
    if (this.ctx) return this.ctx;
    this.ctx = new OfflineAudioContext(1, 1, this.rate ?? FALLBACK_RATE);
    return this.ctx;
  }

  /**
   * Make room for `incoming` bytes, by count and by weight.
   *
   * The count alone was the whole cap, and it is the wrong unit: twenty
   * one-shots are 100MB and twenty five-minute stems are 2.3GB. Evicting runs
   * while either limit is exceeded, and stops when only one entry is left so
   * a buffer larger than the whole budget is still playable.
   */
  private evictIfNeeded(incoming: number): void {
    while (
      this.entries.size > 1 &&
      (this.entries.size >= CACHE_MAX || this.bytes + incoming > CACHE_MAX_BYTES)
    ) {
      let oldest = Infinity;
      let oldestKey = '';
      for (const [key, entry] of this.entries) {
        if (entry.lastUsed < oldest) {
          oldest = entry.lastUsed;
          oldestKey = key;
        }
      }
      const entry = oldestKey ? this.entries.get(oldestKey) : undefined;
      if (!entry) return;
      this.bytes -= entry.bytes;
      this.entries.delete(oldestKey);
    }
  }
}
