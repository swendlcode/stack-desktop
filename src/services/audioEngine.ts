/**
 * audioEngine.ts — Zero-latency audio playback engine
 *
 * Lives entirely outside React. Uses Web Audio API with pre-decoded
 * AudioBuffers so playback is instant — no buffering, no render cycle,
 * no IPC round-trip on the hot path.
 *
 * Strategy:
 *  1. Decode audio files into AudioBuffers ahead of time (background)
 *  2. On play: grab the cached buffer and start a BufferSourceNode immediately
 *  3. React state updates happen AFTER audio starts — UI follows audio, not the other way around
 */

import { convertFileSrc } from '@tauri-apps/api/core';

// How many tracks to pre-decode around the current selection
const PREFETCH_RADIUS = 3;
// Max decoded buffers to keep in memory (~5–10 MB each for a typical sample)
const CACHE_MAX = 20;
// Extra output gain for sample preview playback so perceived loudness is higher.
const SAMPLE_GAIN_BOOST = 2;

// ─── Diagnostics ───────────────────────────────────────────────────────────
// Verbose audio-path tracing, gated so it never spams release builds. Enable in
// the console with `localStorage.setItem('stack:audioDebug','1')` then reload.
// Used to diagnose the "scrubber moves but no sound" report on macOS Tahoe:
// the traces reveal whether the AudioContext is created with a user gesture and
// whether it reaches the 'running' state.
function audioDebugEnabled(): boolean {
  try {
    return localStorage.getItem('stack:audioDebug') === '1';
  } catch {
    return false;
  }
}

function alog(event: string, data?: Record<string, unknown>): void {
  if (!audioDebugEnabled()) return;
  // eslint-disable-next-line no-console
  console.info(`[audio] ${event}`, data ?? '');
}

/** Whether the browser reports an active user gesture right now (WebKit autoplay gate). */
function userActivationActive(): boolean | null {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } })
    .userActivation;
  return ua ? ua.isActive : null;
}

// ─── Output preferences ──────────────────────────────────────────────────────
const SAMPLE_RATE_KEY = 'stack:audioSampleRate';
const SINK_ID_KEY = 'stack:audioSinkId';

function readNumberPref(key: string): number | null {
  try {
    const v = localStorage.getItem(key);
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function readStringPref(key: string): string | null {
  try {
    return localStorage.getItem(key) || null;
  } catch {
    return null;
  }
}

function writePref(key: string, value: string | number | null): void {
  try {
    if (value === null || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

type SinkCapableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };
type SinkCapableMediaEl = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };

/** Native AudioContext output routing (Chromium). WebKit lacks this. */
function supportsContextSink(): boolean {
  try {
    return (
      typeof AudioContext !== 'undefined' &&
      typeof (AudioContext.prototype as SinkCapableContext).setSinkId === 'function'
    );
  } catch {
    return false;
  }
}

/** Media-element output routing. WebKit/WKWebView supports this even without context sink. */
function supportsMediaElementSink(): boolean {
  try {
    return (
      typeof HTMLMediaElement !== 'undefined' &&
      typeof (HTMLMediaElement.prototype as SinkCapableMediaEl).setSinkId === 'function'
    );
  } catch {
    return false;
  }
}

type CacheEntry = {
  buffer: AudioBuffer;
  lastUsed: number;
};

class AudioEngine {
  private ctx: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private cache = new Map<string, CacheEntry>();
  // Single in-flight decode promise per path — prevents duplicate fetches
  private decoding = new Map<string, Promise<AudioBuffer | null>>();
  private volume = 0.8;

  // User audio-output preferences. Persisted in localStorage (device-specific —
  // a deviceId from one Mac is meaningless on another, so we don't sync them).
  // null means "use the system default".
  private preferredSampleRate: number | null = readNumberPref(SAMPLE_RATE_KEY);
  private preferredSinkId: string | null = readStringPref(SINK_ID_KEY);

  // Media-element output routing (WebKit path): gain → MediaStream → <audio>.setSinkId.
  // Only engaged when a non-default device is selected and AudioContext.setSinkId is absent.
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private sinkAudioEl: SinkCapableMediaEl | null = null;

  // Callbacks wired up by usePlayer
  onTimeUpdate: ((time: number) => void) | null = null;
  onDuration: ((duration: number) => void) | null = null;
  onEnded: (() => void) | null = null;

  private tickerRef: number | null = null;
  private startedAt = 0;   // ctx.currentTime when playback started
  private startOffset = 0; // where in the buffer we started from

  // ─── AudioContext ────────────────────────────────────────────────────────

  /**
   * Returns the AudioContext, creating it if needed.
   * Returns a Promise so callers can await resume() before starting a source.
   */
  async getCtxAsync(): Promise<AudioContext> {
    if (!this.ctx || this.ctx.state === 'closed') {
      const Ctor =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      // sampleRate is immutable per context — honoring the user's choice means
      // passing it at construction. Invalid rates throw, so fall back to default.
      try {
        this.ctx = this.preferredSampleRate
          ? new Ctor({ sampleRate: this.preferredSampleRate })
          : new Ctor();
      } catch {
        this.ctx = new Ctor();
      }
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = this.volume * SAMPLE_GAIN_BOOST;
      // The key diagnostic: was the context born inside a user gesture? On WebKit
      // a context created without one can report 'running' yet stay muted.
      alog('ctx:construct', {
        stateAfterCtor: this.ctx.state,
        sampleRate: this.ctx.sampleRate,
        requestedSampleRate: this.preferredSampleRate,
        userActivationActive: userActivationActive(),
      });
      await this.wireOutput();
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
        alog('ctx:resume', { stateAfterResume: this.ctx.state });
      } catch {
        // If resume fails the context is unusable — recreate it next call
        alog('ctx:resume-failed');
        this.ctx = null;
        return this.getCtxAsync();
      }
    }
    return this.ctx;
  }

  /** Synchronous accessor — only safe after getCtxAsync() has been awaited once. */
  private getCtxSync(): AudioContext | null {
    if (!this.ctx || this.ctx.state === 'closed' || this.ctx.state === 'suspended') {
      return null;
    }
    return this.ctx;
  }

  /**
   * Connect the gain node to the chosen output. Three routes, in priority order:
   *  1. No device chosen → straight to ctx.destination (default, lowest latency).
   *  2. AudioContext.setSinkId available (Chromium) → route to destination + set sink.
   *  3. Media-element sink (WebKit) → gain → MediaStream → <audio>.setSinkId.
   * Safe to call repeatedly; it tears down any previous routing first.
   */
  private async wireOutput(): Promise<void> {
    if (!this.ctx || !this.gainNode) return;

    // Tear down whatever was connected before.
    try { this.gainNode.disconnect(); } catch { /* nothing connected */ }
    if (this.sinkAudioEl) {
      this.sinkAudioEl.pause();
      this.sinkAudioEl.srcObject = null;
    }
    this.streamDest = null;

    // Route 1: system default.
    if (!this.preferredSinkId) {
      this.gainNode.connect(this.ctx.destination);
      return;
    }

    // Route 2: native context sink (Chromium).
    const sinkCtx = this.ctx as SinkCapableContext;
    if (typeof sinkCtx.setSinkId === 'function') {
      this.gainNode.connect(this.ctx.destination);
      try {
        await sinkCtx.setSinkId(this.preferredSinkId);
        alog('output:ctxSink', { sinkId: this.preferredSinkId });
      } catch (err) {
        alog('output:ctxSink-failed', { error: String(err) });
      }
      return;
    }

    // Route 3: media-element sink (WebKit) — gain → MediaStream → <audio>.setSinkId.
    if (supportsMediaElementSink()) {
      this.streamDest = this.ctx.createMediaStreamDestination();
      this.gainNode.connect(this.streamDest);
      if (!this.sinkAudioEl) {
        this.sinkAudioEl = new Audio() as SinkCapableMediaEl;
        this.sinkAudioEl.autoplay = true;
      }
      this.sinkAudioEl.srcObject = this.streamDest.stream;
      try {
        await this.sinkAudioEl.setSinkId!(this.preferredSinkId);
        await this.sinkAudioEl.play().catch(() => {});
        alog('output:mediaSink', { sinkId: this.preferredSinkId });
      } catch (err) {
        // Fall back to default so the user still hears something.
        alog('output:mediaSink-failed', { error: String(err) });
        try { this.gainNode.disconnect(); } catch { /* ignore */ }
        this.gainNode.connect(this.ctx.destination);
      }
      return;
    }

    // No routing capability — default.
    this.gainNode.connect(this.ctx.destination);
  }

  /**
   * Tear down the current context and decoded buffers so the next play rebuilds
   * with current preferences. Buffers are decoded at the old context's sample
   * rate, so they must be dropped when the rate changes.
   */
  private async rebuildContext(): Promise<void> {
    this.stopCurrentSource();
    this.cache.clear();
    this.decoding.clear();
    if (this.sinkAudioEl) {
      this.sinkAudioEl.pause();
      this.sinkAudioEl.srcObject = null;
    }
    this.streamDest = null;
    const old = this.ctx;
    this.ctx = null;
    this.gainNode = null;
    if (old && old.state !== 'closed') {
      try { await old.close(); } catch { /* already closing */ }
    }
  }

  // ─── Output preferences (user-facing) ─────────────────────────────────────

  /** Whether output-device selection is usable in this runtime (native or media-element route). */
  supportsOutputSelection(): boolean {
    return (
      (supportsContextSink() || supportsMediaElementSink()) &&
      !!navigator.mediaDevices?.enumerateDevices
    );
  }

  /** List available audio output devices. Labels may be blank without a media-permission grant. */
  async listOutputDevices(): Promise<Array<{ deviceId: string; label: string }>> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === 'audiooutput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label }));
    } catch {
      return [];
    }
  }

  /**
   * WebKit hides output device IDs/labels until the page has been granted a
   * media permission. Briefly opening (and immediately closing) an audio capture
   * stream unlocks enumeration. Returns the re-enumerated device list.
   */
  async unlockOutputDevices(): Promise<Array<{ deviceId: string; label: string }>> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      // Permission denied — fall through and return whatever we can enumerate.
    }
    return this.listOutputDevices();
  }

  getPreferredSinkId(): string | null {
    return this.preferredSinkId;
  }

  /** Set the output device and re-route live (no context rebuild needed). */
  async setOutputDevice(sinkId: string | null): Promise<void> {
    this.preferredSinkId = sinkId;
    writePref(SINK_ID_KEY, sinkId);
    if (this.ctx && this.gainNode) await this.wireOutput();
  }

  getPreferredSampleRate(): number | null {
    return this.preferredSampleRate;
  }

  /** Set the output sample rate. Rebuilds the context (rate is immutable per context). */
  async setPreferredSampleRate(rate: number | null): Promise<void> {
    if (rate === this.preferredSampleRate) return;
    this.preferredSampleRate = rate;
    writePref(SAMPLE_RATE_KEY, rate);
    await this.rebuildContext();
  }

  // ─── Buffer cache ────────────────────────────────────────────────────────

  private evictIfNeeded() {
    if (this.cache.size < CACHE_MAX) return;
    // Remove least-recently-used entry
    let oldest = Infinity;
    let oldestKey = '';
    for (const [k, v] of this.cache) {
      if (v.lastUsed < oldest) {
        oldest = v.lastUsed;
        oldestKey = k;
      }
    }
    if (oldestKey) this.cache.delete(oldestKey);
  }

  /**
   * Fetch + decode a file into an AudioBuffer.
   * Always registers in `decoding` so concurrent callers share the same promise.
   * Returns null on any failure.
   */
  private decodeFile(path: string): Promise<AudioBuffer | null> {
    // Return existing in-flight promise if one exists
    const existing = this.decoding.get(path);
    if (existing) return existing;

    const p = (async (): Promise<AudioBuffer | null> => {
      const url = convertFileSrc(path);
      try {
        const res = await fetch(url);
        if (!res.ok) {
          alog('decode:fetch-failed', { path, status: res.status });
          return null;
        }
        const arrayBuffer = await res.arrayBuffer();
        // Ensure context is running before decoding
        const ctx = await this.getCtxAsync();
        const buffer = await ctx.decodeAudioData(arrayBuffer);
        this.evictIfNeeded();
        this.cache.set(path, { buffer, lastUsed: Date.now() });
        alog('decode:ok', { path, duration: buffer.duration });
        return buffer;
      } catch (err) {
        // decodeAudioData throwing on Tahoe would pin us to the HTML fallback forever.
        alog('decode:error', { path, error: String(err) });
        return null;
      } finally {
        this.decoding.delete(path);
      }
    })();

    this.decoding.set(path, p);
    return p;
  }

  /**
   * Synchronous cache lookup. Returns the buffer if already decoded, null otherwise.
   */
  getBuffer(path: string): AudioBuffer | null {
    const entry = this.cache.get(path);
    if (entry) {
      entry.lastUsed = Date.now();
      return entry.buffer;
    }
    return null;
  }

  /** Kick off background decode for a path (no-op if already cached or decoding) */
  prefetch(path: string): void {
    if (this.cache.has(path)) return;
    if (this.decoding.has(path)) return;
    this.decodeFile(path);
  }

  /** Ensure a buffer is ready, decoding now if needed. Returns the buffer. */
  async ensureBuffer(path: string): Promise<AudioBuffer | null> {
    const cached = this.cache.get(path);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached.buffer;
    }
    return this.decodeFile(path);
  }

  // ─── Playback ────────────────────────────────────────────────────────────

  private stopTicker() {
    if (this.tickerRef !== null) {
      window.clearInterval(this.tickerRef);
      this.tickerRef = null;
    }
  }

  private stopCurrentSource() {
    this.stopTicker();
    const src = this.currentSource;
    if (src) {
      // Null out first so the onended handler is a no-op if it fires after stop()
      this.currentSource = null;
      this.currentPath = null; // Clear path
      src.onended = null;
      try { 
        src.stop(); 
      } catch (error) { 
        // Already stopped or invalid state - this is normal during rapid navigation
      }
      try {
        src.disconnect();
      } catch (error) {
        // Already disconnected - this is normal during rapid navigation
      }
    }
  }

  private currentPath: string | null = null; // Track which path is currently playing

  // Dispatch a custom event when playback starts so UI can react immediately
  private notifyPlaybackStart(path: string) {
    window.dispatchEvent(new CustomEvent('audioEnginePlaybackStart', { 
      detail: { path } 
    }));
  }

  /**
   * Play a buffer immediately. Awaits AudioContext resume so the context is
   * guaranteed to be running before the source starts.
   * Returns true if playback started, false if buffer not cached.
   */
  async playBufferAsync(path: string, offsetSec = 0): Promise<boolean> {
    const buffer = this.getBuffer(path);
    if (!buffer) {
      alog('playAsync:buffer-miss', { path });
      return false;
    }

    const ctx = await this.getCtxAsync();
    this.stopCurrentSource();
    alog('playAsync:start', {
      path,
      ctxState: ctx.state,
      gainValue: this.gainNode?.gain.value,
    });

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode!);

    this.startedAt = ctx.currentTime;
    this.startOffset = Math.max(0, Math.min(offsetSec, buffer.duration));
    this.currentPath = path; // Track the path
    this.notifyPlaybackStart(path); // Notify UI immediately

    source.start(0, this.startOffset);
    this.currentSource = source;

    // Notify duration immediately
    this.onDuration?.(buffer.duration);

    // Start time ticker
    this.tickerRef = window.setInterval(() => {
      const ctx = this.getCtxSync();
      if (!ctx || !this.currentSource) return;
      const elapsed = ctx.currentTime - this.startedAt;
      const current = Math.min(buffer.duration, this.startOffset + elapsed);
      this.onTimeUpdate?.(current);
    }, 50);

    source.onended = () => {
      // Guard: only fire if this source is still the active one
      if (this.currentSource !== source) return;
      this.stopTicker();
      this.currentSource = null;
      this.currentPath = null; // Clear path
      this.onEnded?.();
    };

    return true;
  }

  /**
   * Synchronous play — only works if the AudioContext is already running.
   * Used by the arrow-key handler for zero-latency playback on the hot path.
   * Returns false if context isn't ready or buffer isn't cached.
   */
  playBuffer(path: string, offsetSec = 0): boolean {
    const buffer = this.getBuffer(path);
    if (!buffer) {
      alog('playSync:buffer-miss', { path, userActivationActive: userActivationActive() });
      // Buffer not cached — sync fast path can't play. Critically, if a
      // DIFFERENT asset is currently playing through this engine, stop it
      // now. Otherwise the engine reports `isActive() === true` while the
      // caller's store has switched to a new asset, and the React effect
      // in usePlayer will incorrectly "trust the engine" and never start
      // the new asset. (The "click play → nothing happens until Stop" bug.)
      if (this.currentSource && this.currentPath !== path) {
        this.stopCurrentSource();
      }
      return false;
    }

    const ctx = this.getCtxSync();
    if (!ctx) {
      // The sync path can't run when the context isn't already 'running'. This is
      // the suspected Tahoe failure point: the gesture click lands here, bails, and
      // the context only ever gets resumed later from a non-gesture async path.
      alog('playSync:ctx-not-ready', {
        path,
        ctxState: this.ctx?.state ?? 'none',
        userActivationActive: userActivationActive(),
      });
      // Same reasoning as above — keep the engine's state honest.
      if (this.currentSource && this.currentPath !== path) {
        this.stopCurrentSource();
      }
      return false;
    }

    this.stopCurrentSource();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode!);

    this.startedAt = ctx.currentTime;
    this.startOffset = Math.max(0, Math.min(offsetSec, buffer.duration));
    this.currentPath = path; // Track the path
    this.notifyPlaybackStart(path); // Notify UI immediately

    source.start(0, this.startOffset);
    this.currentSource = source;
    alog('playSync:start', {
      path,
      ctxState: ctx.state,
      gainValue: this.gainNode?.gain.value,
    });

    this.onDuration?.(buffer.duration);

    this.tickerRef = window.setInterval(() => {
      const ctx = this.getCtxSync();
      if (!ctx || !this.currentSource) return;
      const elapsed = ctx.currentTime - this.startedAt;
      const current = Math.min(buffer.duration, this.startOffset + elapsed);
      this.onTimeUpdate?.(current);
    }, 50);

    source.onended = () => {
      if (this.currentSource !== source) return;
      this.stopTicker();
      this.currentSource = null;
      this.currentPath = null; // Clear path
      this.onEnded?.();
    };

    return true;
  }

  pause(): number {
    const ctx = this.getCtxSync();
    const elapsed = ctx ? Math.max(0, ctx.currentTime - this.startedAt) : 0;
    const pausedAt = Math.max(0, this.startOffset + elapsed);
    this.stopCurrentSource();
    return pausedAt;
  }

  stop() {
    this.stopCurrentSource();
    this.startOffset = 0;
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.gainNode) this.gainNode.gain.value = v * SAMPLE_GAIN_BOOST;
  }

  getCurrentTime(): number {
    const ctx = this.getCtxSync();
    if (!ctx || !this.currentSource) return 0;
    return Math.max(0, this.startOffset + (ctx.currentTime - this.startedAt));
  }

  isActive(): boolean {
    return this.currentSource !== null;
  }

  /** Check if the engine is currently playing a specific path */
  isPlayingPath(path: string): boolean {
    return this.currentSource !== null && this.currentPath === path;
  }

  /** Get the path currently being played, or null if nothing is playing */
  getCurrentPath(): string | null {
    return this.currentPath;
  }

  /** Pre-decode the surrounding tracks so they're ready before the user gets there */
  prefetchAround(assets: { path: string; type: string }[], currentIndex: number) {
    const start = Math.max(0, currentIndex - PREFETCH_RADIUS);
    const end = Math.min(assets.length - 1, currentIndex + PREFETCH_RADIUS);
    for (let i = start; i <= end; i++) {
      if (assets[i].type === 'sample') {
        this.prefetch(assets[i].path);
      }
    }
  }

  /** Check if a buffer is already cached and ready for immediate playback */
  isBufferCached(path: string): boolean {
    return this.cache.has(path);
  }

  /** Get cache statistics for debugging */
  getCacheStats(): { size: number; maxSize: number; paths: string[] } {
    return {
      size: this.cache.size,
      maxSize: CACHE_MAX,
      paths: Array.from(this.cache.keys())
    };
  }

  /**
   * One-shot snapshot of the engine's audio state. Surfaced in Settings →
   * Audio diagnostics so an affected user can report it without devtools.
   * `ctxState: 'running'` + a non-zero gain on a machine with no sound is the
   * fingerprint of the "context muted despite running" hypothesis.
   */
  debugSnapshot(): {
    ctxExists: boolean;
    ctxState: AudioContextState | 'none';
    sampleRate: number | null;
    baseLatency: number | null;
    outputLatency: number | null;
    gainValue: number | null;
    volume: number;
    currentPath: string | null;
    cacheSize: number;
    userActivationActive: boolean | null;
  } {
    const ctx = this.ctx;
    return {
      ctxExists: !!ctx,
      ctxState: ctx ? ctx.state : 'none',
      sampleRate: ctx ? ctx.sampleRate : null,
      baseLatency: ctx ? ctx.baseLatency ?? null : null,
      outputLatency:
        ctx && 'outputLatency' in ctx
          ? (ctx as AudioContext & { outputLatency: number }).outputLatency
          : null,
      gainValue: this.gainNode ? this.gainNode.gain.value : null,
      volume: this.volume,
      currentPath: this.currentPath,
      cacheSize: this.cache.size,
      userActivationActive: userActivationActive(),
    };
  }

  /**
   * Play a 1s 440Hz test tone straight to the destination, bypassing the buffer
   * cache and decode path. Isolates the output layer: if this is silent too, the
   * AudioContext itself is muted; if audible, the problem is upstream (decode/gain).
   * Returns the context state so the caller can display it.
   */
  async playTestTone(): Promise<AudioContextState> {
    const ctx = await this.getCtxAsync();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 440;
    gain.gain.value = 0.2;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;
    osc.start(now);
    osc.stop(now + 1);
    alog('testTone', { ctxState: ctx.state, userActivationActive: userActivationActive() });
    return ctx.state;
  }

  /** Clear all cached buffers - used when folders are deleted */
  clearCache(): void {
    this.cache.clear();
    console.log('Audio engine cache cleared');
  }

  /** Clear cached buffers for specific paths - used when specific files are deleted */
  clearCacheForPaths(paths: string[]): void {
    let cleared = 0;
    for (const path of paths) {
      if (this.cache.delete(path)) {
        cleared++;
      }
    }
    if (cleared > 0) {
      console.log(`Audio engine cache cleared for ${cleared} paths`);
    }
  }

  /** Ensure AudioContext is ready for immediate playback - call this during rapid navigation */
  async ensureContextReady(): Promise<void> {
    try {
      await this.getCtxAsync();
    } catch (error) {
      console.warn('Failed to prepare AudioContext:', error);
    }
  }
}

// Singleton — one engine for the whole app
export const audioEngine = new AudioEngine();
