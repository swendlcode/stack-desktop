/**
 * audioEngine.ts — sample playback.
 *
 * Lives entirely outside React. Decoded AudioBuffers are started directly, so
 * an audition costs no render cycle and no IPC round-trip: the UI follows the
 * audio rather than the other way around.
 *
 * This file is only the playing. The rest of the engine is beside it, split
 * out because each piece failed on its own and each is easier to reason about
 * alone:
 *
 *  - `audio/contextKeeper.ts`  the output context and everything that keeps
 *                              it alive: interruption, recovery, the clock
 *                              check that catches a context lying about being
 *                              alive. Most of the hard-won code is here.
 *  - `audio/bufferCache.ts`    decoding and the buffer cache, with their own
 *                              offline context, deliberately independent of
 *                              the output.
 *  - `audio/webkit.ts`         the WKWebView-specific tests and guards.
 *  - `audio/diagnostics.ts`    the always-on event ring behind Settings →
 *                              Audio diagnostics → Copy log.
 *  - `audio/constants.ts`      the tuning numbers, each with the failure that
 *                              chose it.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  INPUT_ATTRIBUTION_MS,
  LOG_DUMP_THROTTLE_MS,
  NO_SOUND_MS,
  SAMPLE_GAIN_BOOST,
  SLOW_START_MS,
} from './audio/constants';
import { lastInput } from './audio/inputClock';
import { alog, formatLog } from './audio/diagnostics';
import { clearOutputPrefs, isRunning, startOffsetFor, userActivationActive } from './audio/webkit';
import { BufferCache } from './audio/bufferCache';
import { ContextKeeper } from './audio/contextKeeper';

// An output preference set by an older build would still be in force with
// nothing in the interface admitting it exists.
clearOutputPrefs();

class AudioEngine {
  // Bumped by every call that changes what should be audible. Anything that
  // awaits must re-check it before starting a source, or it will start a
  // sample the user has already moved on from.
  private intent = 0;
  // When sound was last asked for, and for what. Everything audible is timed
  // against this, because "it feels delayed" is not something anyone can act
  // on and a number is.
  private requestedAt = 0;
  private requestedPath: string | null = null;
  /** Has anything made a sound for `requestedPath` yet? */
  private answered = false;
  private silenceTimer: number | null = null;
  private lastDumpAt = 0;
  // Told when a dead context has been replaced, so the player can decide for
  // itself whether anything should now be playing.
  onContextRestored: (() => void) | null = null;
  /** A source started but was not heard — the player should route it elsewhere. */
  onStartFailed: ((path: string) => void) | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  // Decoded samples. Owns its own decoder, deliberately independent of the
  // output context — see audio/bufferCache.ts.
  private buffers = new BufferCache();
  private volume = 0.8;
  // The output context and its life support — see audio/contextKeeper.ts.
  // Everything it needs from here is passed in, so it can be reasoned about
  // (and repaired) without knowing anything about playback.
  private keeper = new ContextKeeper(this.buffers, {
    stopSource: () => this.stopCurrentSource(),
    currentPath: () => this.currentPath,
    isCurrentTicket: (ticket) => ticket === this.intent,
    onRestored: () => this.onContextRestored?.(),
    onStartFailed: (path) => this.onStartFailed?.(path),
    gainValue: () => this.volume * SAMPLE_GAIN_BOOST,
  });

  // Callbacks wired up by usePlayer
  onTimeUpdate: ((time: number) => void) | null = null;
  onDuration: ((duration: number) => void) | null = null;
  onEnded: (() => void) | null = null;

  private tickerRef: number | null = null;
  private startedAt = 0;   // ctx.currentTime when playback started
  private startOffset = 0; // where in the buffer we started from

  // ─── Buffer cache ────────────────────────────────────────────────────────
  // Thin pass-throughs. The decoding itself lives in audio/bufferCache.ts.

  /** Is this sample already decoded and in memory? */
  hasBuffer(path: string): boolean {
    return this.buffers.has(path);
  }

  getBuffer(path: string): AudioBuffer | null {
    return this.buffers.get(path);
  }

  /** Kick off a background decode (no-op if already cached or decoding). */
  prefetch(path: string): void {
    this.buffers.prefetch(path);
  }

  /** Ensure a buffer is ready, decoding now if needed. */
  ensureBuffer(path: string): Promise<AudioBuffer | null> {
    return this.buffers.ensure(path);
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
  async playBufferAsync(
    path: string,
    offsetSec = 0,
    stillWanted?: () => boolean,
  ): Promise<boolean> {
    const buffer = this.getBuffer(path);
    if (!buffer) {
      alog('playAsync:buffer-miss', { path });
      return false;
    }

    // Claim the output before awaiting anything, and check the claim still
    // holds afterwards. Getting a context can take hundreds of milliseconds
    // when it has to be rebuilt, which is ample time for the user to pick a
    // different sample — and starting this one then is how the wrong sample
    // gets heard.
    // Only if nothing has claimed this one already — the usual route here is
    // a sync play that bailed, and that is the instant the user actually
    // clicked, so overwriting it would hide the very delay being measured.
    if (this.requestedPath !== path) this.noteRequest(path);
    const ticket = ++this.intent;
    const ctx = await this.keeper.getCtxAsync();
    if (ticket !== this.intent) {
      alog('playAsync:superseded', { path });
      return false;
    }
    // The ticket alone was not enough. It is bumped by a *successful* start,
    // by `pause` and by `stop` — not by a click the engine refused, and not
    // by one that went to the element instead. So after a Space switch, where
    // every play parks on a resume, the user could click three more samples
    // without the ticket moving once; when the context finally came back the
    // oldest parked start was still the newest ticket and it played over the
    // top of what was on screen. The store knows what is wanted; ask it.
    if (stillWanted && !stillWanted()) {
      alog('playAsync:no-longer-wanted', { path });
      return false;
    }
    if (!isRunning(ctx)) {
      // Nothing to start into. Say so rather than starting a source that
      // cannot be heard, so the caller can route this somewhere audible.
      alog('playAsync:ctx-not-running', { path, ctxState: ctx.state });
      return false;
    }
    this.stopCurrentSource();
    alog('playAsync:start', {
      path,
      ctxState: ctx.state,
      gainValue: this.keeper.gain?.gain.value,
    });

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.keeper.gain!);

    this.startedAt = ctx.currentTime;
    this.startOffset = startOffsetFor(offsetSec, buffer.duration);
    this.currentPath = path; // Track the path
    this.notifyPlaybackStart(path); // Notify UI immediately

    source.start(0, this.startOffset);
    this.currentSource = source;
    this.keeper.verifyStarted(ctx, ticket);
    this.noteAudible(path, 'async');

    // Notify duration immediately
    this.onDuration?.(buffer.duration);

    // Start time ticker
    this.tickerRef = window.setInterval(() => {
      const ctx = this.keeper.getCtxSync();
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
    // Claimed first, before anything can bail. Every early return below used
    // to leave the ticket untouched, which let a start parked on a resume
    // from several clicks ago still look current when it finally woke up.
    const ticket = ++this.intent;
    this.noteRequest(path);
    const buffer = this.getBuffer(path);
    if (!buffer) {
      alog('playSync:buffer-miss', { path, userActivationActive: userActivationActive() });
      // The decode that follows runs outside this gesture; make sure it has a
      // live context to land in when it finishes.
      this.keeper.heal();
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

    const ctx = this.keeper.getCtxSync();
    if (!ctx) {
      // The sync path can't run when the context isn't already 'running'. This is
      // the suspected Tahoe failure point: the gesture click lands here, bails, and
      // the context only ever gets resumed later from a non-gesture async path.
      alog('playSync:ctx-not-ready', {
        path,
        ctxState: this.keeper.ctx?.state ?? 'none',
        userActivationActive: userActivationActive(),
      });
      // This click is lost to the HTML-audio fallback, but the next one need
      // not be. A click is also the context's best chance of coming back —
      // every account of this WebKit bug ends with "resume it from a gesture
      // handler" — so take it.
      this.keeper.heal();
      // Same reasoning as above — keep the engine's state honest.
      if (this.currentSource && this.currentPath !== path) {
        this.stopCurrentSource();
      }
      return false;
    }

    this.stopCurrentSource();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.keeper.gain!);

    this.startedAt = ctx.currentTime;
    this.startOffset = startOffsetFor(offsetSec, buffer.duration);
    this.currentPath = path; // Track the path
    this.notifyPlaybackStart(path); // Notify UI immediately

    source.start(0, this.startOffset);
    this.currentSource = source;
    this.keeper.verifyStarted(ctx, ticket);
    this.noteAudible(path, 'sync');
    alog('playSync:start', {
      path,
      ctxState: ctx.state,
      gainValue: this.keeper.gain?.gain.value,
    });

    this.onDuration?.(buffer.duration);

    this.tickerRef = window.setInterval(() => {
      const ctx = this.keeper.getCtxSync();
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
    this.intent += 1;
    const ctx = this.keeper.getCtxSync();
    const elapsed = ctx ? Math.max(0, ctx.currentTime - this.startedAt) : 0;
    const pausedAt = Math.max(0, this.startOffset + elapsed);
    this.stopCurrentSource();
    return pausedAt;
  }

  stop() {
    this.intent += 1;
    this.stopCurrentSource();
    this.startOffset = 0;
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.keeper.gain) this.keeper.gain.gain.value = v * SAMPLE_GAIN_BOOST;
  }

  getCurrentTime(): number {
    const ctx = this.keeper.getCtxSync();
    if (!ctx || !this.currentSource) return 0;
    return Math.max(0, this.startOffset + (ctx.currentTime - this.startedAt));
  }

  /**
   * Is the output live *right now* — context running and its clock moving?
   *
   * The player asks before deciding where a click goes. Waiting for the
   * engine to come back is what the delay after a desktop switch actually
   * is: a rebuild, two bounded resumes and a probe, all before the first
   * sound. If the answer here is no, the element can have it immediately.
   */
  isOutputLive(): boolean {
    return this.keeper.getCtxSync() !== null;
  }

  /**
   * Note that the user has asked for a sample, now.
   *
   * Called at the top of both play paths, and by the player before it starts
   * the element, so every route to sound is measured from the same instant.
   */
  noteRequest(path: string): void {
    const now = performance.now();
    // Measure from the press, not from the moment this line finally ran.
    // Otherwise a start that the user waited a third of a second for is
    // recorded as 0ms, because by the engine's reckoning it was instant — it
    // was asked late. That gap is the one part of "it feels delayed" the
    // instrumentation could not see, and it is logged separately so the two
    // halves of the wait can be told apart.
    const pressedAt = lastInput();
    const queued = now - pressedAt;
    const attributable = pressedAt > 0 && queued >= 0 && queued < INPUT_ATTRIBUTION_MS;
    this.requestedAt = attributable ? pressedAt : now;
    if (attributable && queued >= 1) alog('start:queued', { path, ms: Math.round(queued) });
    this.requestedPath = path;
    this.answered = false;
    if (this.silenceTimer !== null) clearTimeout(this.silenceTimer);
    // Silence used to be the one failure that left nothing behind. Every
    // other outcome logs itself: a start is timed, a slow one dumps the ring.
    // A click that simply produced no sound reached none of that code, so the
    // report "I clicked a sample and nothing played, the next one was fine"
    // had no evidence at all behind it. Now it does.
    this.silenceTimer = window.setTimeout(() => {
      this.silenceTimer = null;
      if (this.answered || this.requestedPath !== path) return;
      alog('start:silent', { path, ms: Math.round(performance.now() - this.requestedAt) });
      this.dumpLog('no sound');
    }, NO_SOUND_MS);
  }

  /**
   * Note that sound actually began, and how it got there.
   *
   * `via` is the whole point: 'sync' is the instant path, 'async' means the
   * context had to be woken first, 'element' means the engine could not take
   * it at all. A delay complaint is one of those three with a number on it.
   */
  noteAudible(path: string, via: 'sync' | 'async' | 'element'): void {
    if (this.requestedPath === path) this.answered = true;
    const ms = this.requestedPath === path ? Math.round(performance.now() - this.requestedAt) : -1;
    alog('start:audible', { path, via, ms });
    if (ms >= SLOW_START_MS) this.dumpLog(`slow-start ${via} ${ms}ms`);
  }

  /**
   * Write the event ring to `<app data>/audio-log.txt`.
   *
   * Throttled, and deliberately automatic: asking someone to reproduce a bug
   * and then copy a log before they restart is asking them to be a debugger
   * while they are trying to make music.
   */
  private dumpLog(reason: string): void {
    const now = performance.now();
    if (now - this.lastDumpAt < LOG_DUMP_THROTTLE_MS) return;
    this.lastDumpAt = now;
    const text = `\n===== ${new Date().toISOString()} ${reason}\n${this.recentLog()}`;
    invoke('append_audio_log', { text }).catch(() => {
      // Browser mode, or the command is missing — the in-memory ring and the
      // Copy log button still work.
    });
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
  prefetchAround(assets: { path: string; type: string }[], currentIndex: number): void {
    this.buffers.prefetchAround(assets, currentIndex);
  }

  /** Check if a buffer is already cached and ready for immediate playback */
  isBufferCached(path: string): boolean {
    return this.buffers.has(path);
  }

  /** Get cache statistics for debugging */
  getCacheStats(): { size: number; maxSize: number; paths: string[] } {
    return this.buffers.stats();
  }

  /**
   * One-shot snapshot of the engine's audio state. Surfaced in Settings →
   * Audio diagnostics so an affected user can report it without devtools.
   * `ctxState: 'running'` + a non-zero gain on a machine with no sound is the
   * fingerprint of the "context muted despite running" hypothesis.
   */
  /**
   * Throw the context away and build a fresh one, ignoring every guard.
   *
   * This is the button that used to be "quit Stack and open it again". It
   * deliberately does not go through `recoverOutput`: the whole point is to
   * be usable when that is wedged.
   */
  restartEngine(): Promise<void> {
    return this.keeper.restart();
  }

  /**
   * Record an event in the ring from outside the engine.
   *
   * The player knows something the engine cannot: which sample the interface
   * is actually showing. A start that disagrees with it is the wrong-sample
   * bug happening, and this is what makes it visible in the log rather than
   * only to the user's ears.
   */
  note(event: string, data?: Record<string, unknown>): void {
    alog(event, data);
  }

  /** The recent audio event ring, oldest first, as plain text. */
  recentLog(): string {
    return formatLog(`# stack audio\n# ${JSON.stringify(this.debugSnapshot())}\n`);
  }

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
    /** How long since the clock was last seen to advance; null if never. */
    clockAgeMs: number | null;
    recovering: boolean;
  } {
    const ctx = this.keeper.ctx;
    return {
      ctxExists: !!ctx,
      ctxState: ctx ? ctx.state : 'none',
      sampleRate: ctx ? ctx.sampleRate : null,
      baseLatency: ctx ? ctx.baseLatency ?? null : null,
      outputLatency:
        ctx && 'outputLatency' in ctx
          ? (ctx as AudioContext & { outputLatency: number }).outputLatency
          : null,
      gainValue: this.keeper.gain ? this.keeper.gain.gain.value : null,
      volume: this.volume,
      currentPath: this.currentPath,
      cacheSize: this.buffers.size,
      userActivationActive: userActivationActive(),
      clockAgeMs: this.keeper.clockAgeMs(),
      recovering: this.keeper.repairing,
    };
  }

  /**
   * Play a 1s 440Hz test tone straight to the destination, bypassing the buffer
   * cache and decode path. Isolates the output layer: if this is silent too, the
   * AudioContext itself is muted; if audible, the problem is upstream (decode/gain).
   * Returns the context state so the caller can display it.
   */
  async playTestTone(): Promise<AudioContextState> {
    const ctx = await this.keeper.getCtxAsync();
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
    this.buffers.clear();
    alog('cache:cleared');
  }

  /** Clear cached buffers for specific paths — for files that left the disk. */
  clearCacheForPaths(paths: string[]): void {
    const cleared = this.buffers.clearPaths(paths);
    if (cleared > 0) alog('cache:cleared-paths', { cleared });
  }

  /** Ensure AudioContext is ready for immediate playback - call this during rapid navigation */
  async ensureContextReady(): Promise<void> {
    try {
      await this.keeper.getCtxAsync();
    } catch (error) {
      console.warn('Failed to prepare AudioContext:', error);
    }
  }
}

// Singleton — one engine for the whole app
export const audioEngine = new AudioEngine();
