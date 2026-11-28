/**
 * The sample editor when Rust owns the audio.
 *
 * Same surface as the Web Audio editor, so no component knows the
 * difference, and far less of it: there is no graph to build, no buffer to
 * hold in the webview, and no offline render to run before an export. Every
 * call returns the whole editor state, which is cached here and read back by
 * the getters the UI already uses.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { alog } from './diagnostics';

type Listener = () => void;

/** Mirrors `EditorState` in Rust. */
type Snapshot = {
  loadedPath: string | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  rate: number;
  pitchSemitones: number;
  reversed: boolean;
  loopOn: boolean;
  loopStart: number;
  loopEnd: number;
  highCutHz: number;
  lowCutHz: number;
  channels: number;
  sampleRate: number;
};

const EMPTY: Snapshot = {
  loadedPath: null,
  playing: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  rate: 1,
  pitchSemitones: 0,
  reversed: false,
  loopOn: false,
  loopStart: 0,
  loopEnd: 0,
  highCutHz: 22050,
  lowCutHz: 20,
  channels: 0,
  sampleRate: 0,
};

/** How often the peak meter is drained. */
const METER_MS = 50;

export class BackendEditor {
  private snap: Snapshot = { ...EMPTY };
  private listeners = new Set<Listener>();
  private levels: { left: number; right: number } | null = null;
  private meterTimer: number | null = null;
  /** The last position the backend reported, and when it reported it. */
  private mark = { position: 0, at: 0 };
  private raf: number | null = null;

  constructor() {
    void this.bind();
  }

  private async bind(): Promise<void> {
    // The same playhead the sample player listens to, filtered to the
    // messages that are about the editor. One output, one position, two
    // things that might be using it.
    await listen<{ positionSec: number; playing: boolean; editor: boolean }>(
      'stack://audio-position',
      ({ payload }) => {
        if (!payload.editor) return;
        this.snap = { ...this.snap, playing: payload.playing };
        if (payload.playing) {
          // Re-anchor only on a real jump — a seek, a loop wrap, an edit.
          // The reports arrive ten a second and are up to one audio buffer
          // stale, so correcting to every one of them drags the playhead
          // backwards a few milliseconds at a time. That is the stutter.
          if (Math.abs(this.interpolated() - payload.positionSec) > 0.05) {
            this.mark = { position: payload.positionSec, at: performance.now() };
          }
          this.startTicking();
        } else {
          this.stopTicking();
          this.mark = { position: payload.positionSec, at: performance.now() };
          this.snap = { ...this.snap, currentTime: payload.positionSec };
          this.emit();
        }
      },
    );
    await listen<{ editor: boolean }>('stack://audio-ended', ({ payload }) => {
      if (!payload.editor) return;
      this.stopTicking();
      this.snap = { ...this.snap, playing: false, currentTime: 0 };
      this.mark = { position: 0, at: performance.now() };
      this.emit();
    });
  }

  // ─── Subscription ──────────────────────────────────────────────────────

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Adopt the state a command returned, and tell the UI. */
  private apply(next: Snapshot): Snapshot {
    this.snap = next;
    this.mark = { position: next.currentTime, at: performance.now() };
    if (next.playing) {
      this.startMeter();
      this.startTicking();
    } else {
      this.stopMeter();
      this.stopTicking();
    }
    this.emit();
    return next;
  }

  // ─── The playhead ──────────────────────────────────────────────────────

  /**
   * How fast the playhead moves through the buffer, in buffer-seconds per
   * real second.
   *
   * Pitch is resampling here, so it changes the speed exactly as the speed
   * control does, and interpolating without it is what made the playhead run
   * off the end of the waveform: at -3 semitones the audio plays 16% slower
   * while a playhead advancing at 1.0 reaches the right edge with a sixth of
   * the sample still sounding.
   */
  private effectiveRate(): number {
    return this.snap.rate * Math.pow(2, this.snap.pitchSemitones / 12);
  }

  /** Where the playhead is now, from the last report plus elapsed time. */
  private interpolated(): number {
    const elapsed = (performance.now() - this.mark.at) / 1000;
    let position = this.mark.position + elapsed * this.effectiveRate();
    const { loopOn, loopStart, loopEnd, duration } = this.snap;
    if (loopOn && loopEnd > loopStart) {
      if (position >= loopEnd) {
        position = loopStart + ((position - loopStart) % (loopEnd - loopStart));
      }
    } else if (duration > 0) {
      position = Math.min(position, duration);
    }
    return position;
  }

  /**
   * Drive the playhead at frame rate between reports.
   *
   * The backend sends a position ten times a second, which is plenty to stay
   * accurate and far too few to look smooth — the indicator visibly stepped.
   * Pushing it at frame rate over IPC would cost sixty round trips a second
   * to tell us something arithmetic already knows.
   */
  private startTicking(): void {
    if (this.raf !== null) return;
    const tick = () => {
      if (!this.snap.playing) {
        this.raf = null;
        return;
      }
      this.snap = { ...this.snap, currentTime: this.interpolated() };
      this.emit();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopTicking(): void {
    if (this.raf === null) return;
    cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private async call(command: string, args?: Record<string, unknown>): Promise<Snapshot> {
    try {
      return this.apply(await invoke<Snapshot>(command, args));
    } catch (err) {
      alog('editor:failed', { command, error: String(err) });
      return this.snap;
    }
  }

  // ─── Metering ──────────────────────────────────────────────────────────

  /**
   * Peak per channel, 0..1, or null before anything has played.
   *
   * Polled rather than pushed, and the backend clears its peak on every
   * read — so this reports the loudest sample of each window rather than
   * whatever happened to be passing when the animation frame fired. A meter
   * is there to warn about clipping and an averaged one hides exactly the
   * transients that clip.
   */
  readLevels(): { left: number; right: number } | null {
    return this.levels;
  }

  private startMeter(): void {
    if (this.meterTimer !== null) return;
    this.meterTimer = window.setInterval(() => {
      void invoke<[number, number]>('editor_levels')
        .then(([left, right]) => {
          this.levels = { left, right };
        })
        .catch(() => {});
    }, METER_MS);
  }

  private stopMeter(): void {
    if (this.meterTimer === null) return;
    window.clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.levels = { left: 0, right: 0 };
  }

  // ─── State the UI reads ────────────────────────────────────────────────

  get loadedPath(): string | null { return this.snap.loadedPath; }
  get playing(): boolean { return this.snap.playing; }
  get currentTime(): number { return this.snap.currentTime; }
  get duration(): number { return this.snap.duration; }
  get volume(): number { return this.snap.volume; }
  get rate(): number { return this.snap.rate; }
  get pitchSemitones(): number { return this.snap.pitchSemitones; }
  get reversed(): boolean { return this.snap.reversed; }
  get loopOn(): boolean { return this.snap.loopOn; }
  get loopStart(): number { return this.snap.loopStart; }
  get loopEnd(): number { return this.snap.loopEnd; }
  get highCutHz(): number { return this.snap.highCutHz; }
  get lowCutHz(): number { return this.snap.lowCutHz; }

  /** The audio lives in Rust; nothing here holds a decoded buffer. */
  get buffered(): AudioBuffer | null { return null; }
  get workBuffer(): AudioBuffer | null { return null; }

  // ─── Loading ───────────────────────────────────────────────────────────

  async load(path: string): Promise<boolean> {
    const next = await this.call('editor_load', { path });
    return next.loadedPath === path;
  }

  async unload(): Promise<void> {
    await this.call('editor_unload');
  }

  async resetEdits(): Promise<void> {
    await this.call('editor_reset');
  }

  // ─── Transport ─────────────────────────────────────────────────────────

  async play(fromSec?: number): Promise<void> {
    await this.call('editor_play', { fromSec: fromSec ?? null });
  }

  async pause(): Promise<void> {
    await this.call('editor_pause');
  }

  async stop(): Promise<void> {
    await this.call('editor_stop');
  }

  async seek(sec: number): Promise<void> {
    await this.call('editor_seek', { sec });
  }

  // ─── Live controls ─────────────────────────────────────────────────────
  //
  // Each one is a slider, and each sends only what moved. The backend
  // retunes the voice in place rather than restarting it, so a drag changes
  // the sound without a gap.

  /**
   * Nothing to do: the mixer applies the player bar's volume to the editor's
   * voice itself, alongside the browser's. Here so both editors present the
   * same surface.
   */
  setMonitorVolume(_v: number): void {}

  async setVolume(v: number): Promise<void> {
    await this.call('editor_set', { settings: { volume: v } });
  }

  async setRate(r: number): Promise<void> {
    await this.call('editor_set', { settings: { rate: r } });
  }

  async setPitch(semitones: number): Promise<void> {
    await this.call('editor_set', { settings: { pitchSemitones: semitones } });
  }

  async setHighCut(hz: number): Promise<void> {
    await this.call('editor_set', { settings: { highCutHz: hz } });
  }

  async setLowCut(hz: number): Promise<void> {
    await this.call('editor_set', { settings: { lowCutHz: hz } });
  }

  async setLoop(on: boolean, start?: number, end?: number): Promise<void> {
    await this.call('editor_set', {
      settings: { loopOn: on, loopStart: start ?? null, loopEnd: end ?? null },
    });
  }

  // ─── Destructive edits ─────────────────────────────────────────────────

  async reverse(): Promise<void> {
    await this.call('editor_reverse');
  }

  async normalize(): Promise<void> {
    await this.call('editor_normalize');
  }

  async deleteRegion(startSec: number, endSec: number): Promise<void> {
    await this.call('editor_delete_region', { startSec, endSec });
  }

  // ─── Display and export ────────────────────────────────────────────────

  /**
   * The working buffer downmixed to mono, for drawing.
   *
   * Arrives as raw bytes and is wrapped without a copy. Serialising three
   * quarters of a million floats as JSON would cost more than decoding the
   * file did.
   */
  async monoSamples(): Promise<Float32Array | null> {
    try {
      const bytes = await invoke<ArrayBuffer | number[]>('editor_waveform');
      const buffer = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
      const samples = new Float32Array(buffer);
      return samples.length ? samples : null;
    } catch (err) {
      alog('editor:waveform-failed', { error: String(err) });
      return null;
    }
  }

  /**
   * Render the edit to a WAV and return its path.
   *
   * Nothing but the filename and the path crosses the boundary. The Web
   * Audio route rendered offline in the webview, encoded a WAV there, and
   * sent roughly three megabytes back to Rust as a JSON array of integers so
   * that Rust could write it to disk.
   */
  async exportEdit(filename: string): Promise<string | null> {
    try {
      return await invoke<string>('editor_export', { filename });
    } catch (err) {
      alog('editor:export-failed', { error: String(err) });
      return null;
    }
  }
}
