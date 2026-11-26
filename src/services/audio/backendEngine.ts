/**
 * The engine when the backend owns the output device.
 *
 * It presents the same surface as the Web Audio engine so nothing upstream
 * has to know which one it is talking to, and it is deliberately much
 * smaller: there is no context to keep alive, no clock to interrogate, no
 * device fingerprint to infer and no fallback to hand a sample to. Those all
 * existed to work out whether WebKit was telling the truth. Rust holds the
 * device, so the answer is simply known.
 *
 * Browser mode still uses the Web Audio path — the library is served over the
 * network there, and this process's speakers are the wrong ones.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { PREFETCH_MAX_SECONDS, PREFETCH_RADIUS } from './constants';
import { alog, clearLog as clearLogRing, formatLog, logLength } from './diagnostics';

/** What `audio_state` returns. Mirrors `PlaybackState` in Rust. */
type BackendState = {
  playing: boolean;
  path: string | null;
  positionSec: number;
  durationSec: number;
  generation: number;
  endedGeneration: number;
  deviceName: string;
  deviceRate: number;
  deviceFailed: boolean;
  cached: number;
  cachedBytes: number;
};

type PrefetchAsset = { path: string; type: string; durationMs?: number | null };

export class BackendEngine {
  onContextRestored: (() => void) | null = null;
  onStartFailed: ((path: string) => void) | null = null;
  onTimeUpdate: ((time: number) => void) | null = null;
  onDuration: ((duration: number) => void) | null = null;
  onEnded: (() => void) | null = null;

  private path: string | null = null;
  private playing = false;
  private duration = 0;
  private volume = 1;
  /** Last position the backend reported, and when it reported it. */
  private mark = { position: 0, at: 0 };
  private device = { name: '', rate: 0, failed: false };
  private raf: number | null = null;
  /** Paths the backend has already refused. */
  private failed = new Set<string>();

  /**
   * No element fallback, deliberately.
   *
   * It was the Web Audio engine's safety net for a context that would not
   * start. There is nothing here for it to rescue: symphonia decodes more
   * formats than the WKWebView media loader, which cannot read an asset://
   * URL at all. A file this engine refuses is one the element refuses a
   * moment later, and its refusal hands the sample straight back here.
   */
  readonly elementFallback = false;

  constructor() {
    void this.bind();
  }

  private async bind(): Promise<void> {
    // The playhead arrives ten times a second and is interpolated between
    // ticks below. Pushing it at frame rate over IPC would cost far more than
    // it buys: the backend's frame counter is exact, so between two reports
    // the position is simply the elapsed wall time.
    await listen<{
      positionSec: number;
      durationSec: number;
      playing: boolean;
      editor: boolean;
    }>(
      'stack://audio-position',
      ({ payload }) => {
        // One output, one playhead, two things that might be driving it.
        // Without this the editor's position moved the browser's transport
        // and reported the editor's duration as the current sample's.
        if (payload.editor) return;
        this.mark = { position: payload.positionSec, at: performance.now() };
        this.duration = payload.durationSec;
        this.playing = payload.playing;
        this.onDuration?.(payload.durationSec);
        if (payload.playing) this.startTicking();
        else this.stopTicking(payload.positionSec);
      },
    );

    await listen<{ editor: boolean }>('stack://audio-ended', ({ payload }) => {
      if (payload.editor) return;
      this.playing = false;
      this.stopTicking(this.duration);
      alog('backend:ended', { path: this.path });
      this.onEnded?.();
    });

    void this.refreshDevice();
  }

  private async refreshDevice(): Promise<void> {
    try {
      const state = await invoke<BackendState>('audio_state');
      this.device = {
        name: state.deviceName,
        rate: state.deviceRate,
        failed: state.deviceFailed,
      };
      alog('backend:device', {
        device: state.deviceName,
        rate: state.deviceRate,
        failed: state.deviceFailed,
      });
    } catch (err) {
      alog('backend:device-unavailable', { error: String(err) });
    }
  }

  // ─── The playhead ──────────────────────────────────────────────────────

  private startTicking(): void {
    if (this.raf !== null) return;
    const tick = () => {
      if (!this.playing) {
        this.raf = null;
        return;
      }
      this.onTimeUpdate?.(this.currentTime());
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopTicking(finalPosition: number): void {
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.mark = { position: finalPosition, at: performance.now() };
    this.onTimeUpdate?.(finalPosition);
  }

  private currentTime(): number {
    if (!this.playing) return this.mark.position;
    const elapsed = (performance.now() - this.mark.at) / 1000;
    const position = this.mark.position + elapsed;
    return this.duration > 0 ? Math.min(position, this.duration) : position;
  }

  getCurrentTime(): number {
    return this.currentTime();
  }

  // ─── Starting and stopping ─────────────────────────────────────────────

  /**
   * Start a sample.
   *
   * Returns true without waiting, and means it. The boolean exists because
   * the Web Audio engine could genuinely fail to take a sample and the caller
   * had to know before pausing the element it was going to hand over from.
   * There is no handover here: the command is queued, the backend decodes if
   * it must, and the only way this does not produce sound is no output device
   * at all, which `isOutputLive` reports on its own.
   */
  playBuffer(path: string, offsetSec = 0): boolean {
    if (this.device.failed) {
      alog('backend:no-device', { path });
      return false;
    }
    // Asked and answered. Without this a bad file costs a round trip, a
    // full read and a probe on every press.
    if (this.failed.has(path)) return false;
    this.noteRequest(path);
    this.path = path;
    this.playing = true;
    this.mark = { position: offsetSec, at: performance.now() };
    this.startTicking();
    void invoke<BackendState>('audio_play', { path, offsetSec })
      .then((state) => {
        this.duration = state.durationSec;
        this.onDuration?.(state.durationSec);
        this.noteAudible(path, 'sync');
      })
      .catch((err) => {
        this.playing = false;
        this.stopTicking(0);
        // Logged once per path, and `onStartFailed` is deliberately not
        // called: that hook routes to the element, which refuses and hands
        // the sample back here. Eighty round trips in two hundred
        // milliseconds on one corrupt file, which is how this was found.
        if (!this.failed.has(path)) {
          this.failed.add(path);
          alog('backend:play-failed', { path, error: String(err) });
        }
      });
    return true;
  }

  /**
   * The seek path calls this with a predicate from the store.
   *
   * It is honoured rather than ignored. There is no long await here for the
   * user to overtake — the command is queued, not parked on a WebKit promise
   * — but a seek can still be superseded between the handler running and this
   * line, and starting then is how the wrong sample gets heard.
   */
  /**
   * Render a MIDI performance in Rust and play it through the same mixer.
   *
   * It is a sample by the time it reaches the output, so it inherits the
   * ramps, the exact playhead, seek, pause and a real end event — none of
   * which the Web Audio synth had, because it scheduled a few hundred
   * oscillator nodes and then guessed when they had finished.
   */
  playMidi(notes: unknown[], durationSec: number, offsetSec = 0): boolean {
    if (this.device.failed) return false;
    this.path = '<midi>';
    this.playing = true;
    this.duration = durationSec;
    this.mark = { position: offsetSec, at: performance.now() };
    this.startTicking();
    void invoke<BackendState>('audio_play_midi', { notes, durationSec, offsetSec })
      .then(() => alog('backend:midi', { notes: notes.length, durationSec, offsetSec }))
      .catch((err) => {
        this.playing = false;
        this.stopTicking(0);
        alog('backend:midi-failed', { error: String(err) });
      });
    return true;
  }

  async playBufferAsync(
    path: string,
    offsetSec = 0,
    stillWanted?: () => boolean,
  ): Promise<boolean> {
    if (stillWanted && !stillWanted()) {
      alog('backend:no-longer-wanted', { path });
      return false;
    }
    return this.playBuffer(path, offsetSec);
  }

  pause(): number {
    const at = this.currentTime();
    this.playing = false;
    this.stopTicking(at);
    void invoke('audio_pause').catch(() => {});
    return at;
  }

  resume(): void {
    this.playing = true;
    this.mark = { position: this.mark.position, at: performance.now() };
    this.startTicking();
    void invoke('audio_resume').catch(() => {});
  }

  stop(): void {
    this.playing = false;
    this.path = null;
    this.stopTicking(0);
    void invoke('audio_stop').catch(() => {});
  }

  seek(positionSec: number): void {
    this.mark = { position: positionSec, at: performance.now() };
    void invoke('audio_seek', { positionSec }).catch(() => {});
  }

  setVolume(v: number): void {
    this.volume = v;
    void invoke('audio_set_volume', { volume: v }).catch(() => {});
  }

  // ─── Decoding ahead ────────────────────────────────────────────────────

  prefetch(path: string): void {
    void invoke('audio_prefetch', { paths: [path] }).catch(() => {});
  }

  ensureBuffer(path: string): Promise<null> {
    return invoke('audio_prefetch', { paths: [path] })
      .then(() => null)
      .catch(() => null);
  }

  /**
   * Decode the neighbourhood, nearest first.
   *
   * One call carrying the whole list rather than one per neighbour: the
   * backend decides how many to run at once, which is the thing the webview
   * could not do — seven parallel whole-file decodes competing with the
   * sample the user had actually pressed is where the delay came from.
   */
  prefetchAround(assets: PrefetchAsset[], currentIndex: number): void {
    const order = [currentIndex];
    for (let d = 1; d <= PREFETCH_RADIUS; d += 1) order.push(currentIndex + d, currentIndex - d);
    const paths: string[] = [];
    for (const i of order) {
      if (i < 0 || i >= assets.length) continue;
      const asset = assets[i];
      if (!asset || asset.type !== 'sample') continue;
      if (asset.durationMs != null && asset.durationMs > PREFETCH_MAX_SECONDS * 1000) continue;
      paths.push(asset.path);
    }
    if (paths.length) void invoke('audio_prefetch', { paths }).catch(() => {});
  }

  hasBuffer(_path: string): boolean {
    // The backend decides. Saying "yes" keeps callers on the direct path,
    // which is now the only path there is.
    return true;
  }

  isBufferCached(_path: string): boolean {
    return true;
  }

  getCacheStats(): { size: number; maxSize: number; paths: string[] } {
    return { size: 0, maxSize: 0, paths: [] };
  }

  clearCache(): void {
    /* The backend's cache is bounded and keyed by device rate; nothing here
       owns it. */
  }

  clearCacheForPaths(_paths: string[]): void {}

  // ─── State ─────────────────────────────────────────────────────────────

  isActive(): boolean {
    return this.playing;
  }

  isPlayingPath(path: string): boolean {
    return this.playing && this.path === path;
  }

  getCurrentPath(): string | null {
    return this.path;
  }

  /** Whether there is an output device at all. Not a guess. */
  isOutputLive(): boolean {
    return !this.device.failed;
  }

  async ensureContextReady(): Promise<void> {
    await this.refreshDevice();
  }

  async playTestTone(): Promise<AudioContextState> {
    try {
      await invoke<BackendState>('audio_test_tone');
      return 'running';
    } catch (err) {
      alog('backend:test-tone-failed', { error: String(err) });
      return 'closed';
    }
  }

  /** Reopen the stream. The backend already does this when the device moves. */
  async reopenDevice(): Promise<void> {
    await invoke('audio_reopen_device').catch(() => {});
    await this.refreshDevice();
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────

  noteRequest(path: string): void {
    alog('start:queued', { path });
  }

  noteAudible(path: string, via: 'sync' | 'async' | 'element'): void {
    alog('start:audible', { path, via });
  }

  note(event: string, data?: Record<string, unknown>): void {
    alog(event, data);
  }

  recentLog(): string {
    const header =
      `# stack audio (backend)\n# ${JSON.stringify({
        device: this.device.name,
        rate: this.device.rate,
        deviceFailed: this.device.failed,
        playing: this.playing,
        path: this.path,
        position: Number(this.currentTime().toFixed(3)),
        duration: this.duration,
        volume: this.volume,
        events: logLength(),
      })}\n`;
    return formatLog(header);
  }

  clearLog(): void {
    clearLogRing();
    alog('log:cleared');
  }

  /**
   * The same shape the Web Audio engine reports, so one panel renders either.
   *
   * Most of it is null here, and that is the point: there is no context to
   * be in a state, no gain node to read, no clock to have gone stale and no
   * output tap to peak. Those fields exist because the webview could only
   * ever infer whether it was producing sound. `outputDevice` is no longer an
   * inference from a latency figure — it is the name the host gave us.
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
    cacheBytes: number;
    userActivationActive: boolean | null;
    clockAgeMs: number | null;
    outputPeak: number | null;
    outputDevice: string | null;
    recovering: boolean;
    backend: boolean;
  } {
    return {
      ctxExists: !this.device.failed,
      ctxState: this.device.failed ? 'none' : 'running',
      sampleRate: this.device.rate || null,
      baseLatency: null,
      outputLatency: null,
      gainValue: null,
      volume: this.volume,
      currentPath: this.path,
      cacheSize: 0,
      cacheBytes: 0,
      userActivationActive: null,
      clockAgeMs: null,
      outputPeak: null,
      outputDevice: this.device.name || null,
      recovering: false,
      backend: true,
    };
  }
}
