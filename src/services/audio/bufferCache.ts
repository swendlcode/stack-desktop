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
import { CACHE_MAX, PREFETCH_RADIUS } from './constants';
import { alog } from './diagnostics';

type CacheEntry = {
  buffer: AudioBuffer;
  lastUsed: number;
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

  get size(): number {
    return this.entries.size;
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

  /** Decode now if needed, and return the buffer. */
  async ensure(path: string): Promise<AudioBuffer | null> {
    return this.get(path) ?? this.decode(path);
  }

  /** Start a background decode. No-op if cached or already decoding. */
  prefetch(path: string): void {
    if (this.entries.has(path) || this.decoding.has(path)) return;
    void this.decode(path);
  }

  /** Decode what the user is about to reach, in both directions. */
  prefetchAround(assets: { path: string; type: string }[], currentIndex: number): void {
    const start = Math.max(0, currentIndex - PREFETCH_RADIUS);
    const end = Math.min(assets.length - 1, currentIndex + PREFETCH_RADIUS);
    for (let i = start; i <= end; i += 1) {
      if (assets[i].type === 'sample') this.prefetch(assets[i].path);
    }
  }

  clear(): void {
    this.entries.clear();
    this.decoding.clear();
    this.rate = null;
  }

  /** Drop in-flight decodes only — used when the output context is replaced. */
  dropPending(): void {
    this.decoding.clear();
  }

  /** Forget specific samples, for files that have left the disk. */
  clearPaths(paths: string[]): number {
    let cleared = 0;
    for (const path of paths) {
      if (this.entries.delete(path)) cleared += 1;
    }
    return cleared;
  }

  stats(): { size: number; maxSize: number; paths: string[] } {
    return { size: this.entries.size, maxSize: CACHE_MAX, paths: [...this.entries.keys()] };
  }

  private decode(path: string): Promise<AudioBuffer | null> {
    const existing = this.decoding.get(path);
    if (existing) return existing;

    const job = (async (): Promise<AudioBuffer | null> => {
      try {
        const res = await fetch(convertFileSrc(path));
        if (!res.ok) {
          alog('decode:fetch-failed', { path, status: res.status });
          return null;
        }
        const bytes = await res.arrayBuffer();
        const buffer = await this.decodeCtx().decodeAudioData(bytes);
        this.evictIfNeeded();
        this.entries.set(path, { buffer, lastUsed: Date.now() });
        alog('decode:ok', { path, duration: buffer.duration });
        return buffer;
      } catch (err) {
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

  private evictIfNeeded(): void {
    if (this.entries.size < CACHE_MAX) return;
    let oldest = Infinity;
    let oldestKey = '';
    for (const [key, entry] of this.entries) {
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) this.entries.delete(oldestKey);
  }
}
