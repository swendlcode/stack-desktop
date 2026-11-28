import { convertFileSrc, invoke } from '@tauri-apps/api/core';

import { encodeWav } from './wavEncoder';
import { isTauri } from '../lib/tauri-core';
import { BackendEditor } from './audio/backendEditor';

type Listener = () => void;

// 1024 samples is ~21ms at 48kHz: long enough that a peak is not missed
// between animation frames, short enough that the reading is current.
const METER_FFT = 1024;

class EditorEngine {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private lowpass: BiquadFilterNode | null = null;   // high-cut
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private meterScratch: Float32Array<ArrayBuffer> | null = null;
  private highpass: BiquadFilterNode | null = null;  // low-cut
  private startedAtCtx = 0;
  private startOffset = 0;
  private ticker: number | null = null;
  private listeners = new Set<Listener>();

  private _loadedPath: string | null = null;
  private _playing = false;
  private _currentTime = 0;
  private _duration = 0;

  private _volume = 1;
  /**
   * The player bar's volume, applied to monitoring only.
   *
   * Deliberately separate from `_volume`: that one is baked into an export,
   * and how loud you are listening has no business ending up in the file.
   * The desktop build does the same thing one layer down, in the mixer.
   */
  private _monitor = 1;
  private _rate = 1;
  private _loopOn = false;
  private _loopStart = 0;
  private _loopEnd = 0;
  private _highCutHz = 22050;
  private _lowCutHz = 20;
  private _pitchSemitones = 0;   // -24 … +24 semitones
  private _reversed = false;
  // Working buffer — may differ from the original when reverse/normalize applied
  private _workBuffer: AudioBuffer | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  get loadedPath() { return this._loadedPath; }
  get playing() { return this._playing; }
  get currentTime() { return this._currentTime; }
  get duration() { return this._duration; }
  /** The original decoded buffer (never mutated). */
  get buffered() { return this.buffer; }
  /** The working buffer (reversed / normalized copy, or same as buffered). */
  get workBuffer() { return this._workBuffer ?? this.buffer; }

  private async ensureGraph() {
    if (this.ctx) return this.ctx;
    const Ctor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this._volume * this._monitor;
    this.highpass = this.ctx.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.frequency.value = this._lowCutHz;
    this.lowpass = this.ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = this._highCutHz;
    this.highpass.connect(this.lowpass).connect(this.gain).connect(this.ctx.destination);

    // Metering tap, post-gain — the same point a mixer meter reads, so the
    // GAIN knob moves the needle like a fader does.
    //
    // The tap exists because a splitter alone gets mono wrong: its default
    // interpretation is "discrete", so a one-channel source lights the left
    // bar and leaves the right silent. Forcing two channels with "speakers"
    // interpretation up-mixes mono to both, which is what a meter should show.
    // Nothing downstream of the analysers is connected, so this branch is a
    // read and never reaches the output twice.
    const tap = this.ctx.createGain();
    tap.channelCount = 2;
    tap.channelCountMode = 'explicit';
    tap.channelInterpretation = 'speakers';
    const splitter = this.ctx.createChannelSplitter(2);
    this.analyserL = this.ctx.createAnalyser();
    this.analyserR = this.ctx.createAnalyser();
    for (const a of [this.analyserL, this.analyserR]) {
      a.fftSize = METER_FFT;
      a.smoothingTimeConstant = 0;  // ballistics belong in the meter, not here
    }
    this.gain.connect(tap);
    tap.connect(splitter);
    splitter.connect(this.analyserL, 0);
    splitter.connect(this.analyserR, 1);
    this.meterScratch = new Float32Array(METER_FFT);

    return this.ctx;
  }

  /**
   * Peak level of each channel since the last read, 0..1 linear.
   *
   * Peak rather than RMS: a meter is there to warn about clipping, and an
   * averaged reading hides exactly the transients that clip. `null` means
   * there is no graph yet — nothing has been played.
   */
  readLevels(): { left: number; right: number } | null {
    const buf = this.meterScratch;
    if (!this.analyserL || !this.analyserR || !buf) return null;
    const peak = (node: AnalyserNode) => {
      node.getFloatTimeDomainData(buf);
      let max = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] < 0 ? -buf[i] : buf[i];
        if (v > max) max = v;
      }
      return max;
    };
    return { left: peak(this.analyserL), right: peak(this.analyserR) };
  }

  async load(path: string): Promise<boolean> {
    if (this._loadedPath === path && this.buffer) return true;
    this.stop();
    const ctx = await this.ensureGraph();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    try {
      const res = await fetch(convertFileSrc(path));
      if (!res.ok) return false;
      const ab = await res.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      this.buffer = buf;
      this._workBuffer = null;
      this._loadedPath = path;
      this._duration = buf.duration;
      this._currentTime = 0;
      this._loopStart = 0;
      this._loopEnd = buf.duration;
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resets every per-sample edit (rate, gain, filters, loop, pitch, reverse) back to
   * defaults and pushes the new values onto the live graph nodes. Display
   * preferences like waveform color live in `editorStore` and are not
   * touched here.
   */
  async resetEdits() {
    this._rate = 1;
    this._volume = 1;
    this._highCutHz = 22050;
    this._lowCutHz = 20;
    this._loopOn = false;
    this._loopStart = 0;
    this._loopEnd = this._duration;
    this._pitchSemitones = 0;
    this._reversed = false;
    this._workBuffer = null;
    if (this.source) {
      this.source.playbackRate.value = 1;
      this.source.loop = false;
      this.source.loopStart = 0;
      this.source.loopEnd = this._duration;
    }
    if (this.gain) this.gain.gain.value = this._monitor;
    if (this.lowpass) this.lowpass.frequency.value = 22050;
    if (this.highpass) this.highpass.frequency.value = 20;
    this.emit();
  }

  async play(fromSec?: number) {
    if (!this.buffer || !this.ctx) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    this.stopSource();
    const src = this.ctx.createBufferSource();
    // Use work buffer (reversed/normalized) if available, else original
    src.buffer = this._workBuffer ?? this.buffer;
    src.playbackRate.value = this.effectiveRate();
    if (this._loopOn) {
      src.loop = true;
      src.loopStart = this._loopStart;
      src.loopEnd = this._loopEnd > this._loopStart ? this._loopEnd : (this._workBuffer ?? this.buffer).duration;
    }
    src.connect(this.highpass!);
    const offset = Math.max(0, Math.min((this._workBuffer ?? this.buffer).duration, fromSec ?? this._currentTime));
    this.startOffset = offset;
    this.startedAtCtx = this.ctx.currentTime;
    src.start(0, offset);
    this.source = src;
    this._playing = true;
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      this._playing = false;
      this._currentTime = 0;
      this.stopTicker();
      this.emit();
    };
    this.startTicker();
    this.emit();
  }

  /**
   * How fast the playhead moves through the buffer, in buffer-seconds per
   * real second. Pitch is implemented by resampling, so it changes the speed
   * exactly as the rate control does — and every conversion between wall
   * clock and buffer position has to use both.
   *
   * Leaving pitch out of this is what made the playhead run off the end of
   * the waveform: at -3 semitones the audio plays 16% slower while the
   * playhead kept advancing at 1.0, so it reached the right edge with a sixth
   * of the sample still sounding.
   */
  private effectiveRate(): number {
    return this._rate * Math.pow(2, this._pitchSemitones / 12);
  }

  /** Current buffer position, from the clock. Valid only while playing. */
  private positionNow(): number {
    if (!this.ctx) return this._currentTime;
    const elapsed = (this.ctx.currentTime - this.startedAtCtx) * this.effectiveRate();
    return Math.max(0, this.startOffset + elapsed);
  }

  /**
   * Re-anchor the clock to the position reached so far.
   *
   * Required before any speed change during playback: `startedAtCtx` and
   * `startOffset` describe a straight line from the last anchor, so changing
   * the slope without moving the anchor retroactively re-times everything
   * already played and the playhead jumps.
   */
  private rebaseClock() {
    if (!this._playing || !this.ctx) return;
    this.startOffset = this.positionNow();
    this.startedAtCtx = this.ctx.currentTime;
  }

  async pause() {
    if (!this._playing || !this.ctx) return;
    this._currentTime = this.positionNow();
    this.stopSource();
    this._playing = false;
    this.stopTicker();
    this.emit();
  }

  async stop() {
    this.stopSource();
    this._currentTime = 0;
    this._playing = false;
    this.stopTicker();
    this.emit();
  }

  async seek(sec: number) {
    const t = Math.max(0, Math.min(this._duration, sec));
    this._currentTime = t;
    if (this._playing) this.play(t);
    else this.emit();
  }

  async setVolume(v: number) {
    this._volume = v;
    if (this.gain) this.gain.gain.value = v * this._monitor;
    this.emit();
  }
  get volume() { return this._volume; }

  /** Follow the player bar's volume, without touching what an export renders. */
  setMonitorVolume(v: number) {
    this._monitor = v;
    if (this.gain) this.gain.gain.value = this._volume * v;
  }

  async setRate(r: number) {
    this.rebaseClock();
    this._rate = r;
    if (this.source) this.source.playbackRate.value = this.effectiveRate();
    this.emit();
  }
  get rate() { return this._rate; }

  /** Shift pitch by semitones (-24 to +24). Does not affect playback speed. */
  async setPitch(semitones: number) {
    this.rebaseClock();
    this._pitchSemitones = Math.max(-24, Math.min(24, semitones));
    if (this.source) this.source.playbackRate.value = this.effectiveRate();
    this.emit();
  }
  get pitchSemitones() { return this._pitchSemitones; }

  /**
   * Reverses the audio buffer in-place (creates a new work buffer).
   * Calling again un-reverses it.
   */
  async reverse() {
    const src = this.buffer;
    if (!src) return;
    const wasPlaying = this._playing;
    const wasTime = this._currentTime;
    this.stop();

    if (this._reversed) {
      // Un-reverse: restore original
      this._workBuffer = null;
      this._reversed = false;
    } else {
      // Reverse: create a new buffer with all channels reversed
      const ctx = this.ctx;
      if (!ctx) {
        // Create a temporary offline context just to make a buffer
        const rev = new OfflineAudioContext(src.numberOfChannels, src.length, src.sampleRate);
        const revBuf = rev.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
        for (let c = 0; c < src.numberOfChannels; c++) {
          const orig = src.getChannelData(c);
          const dest = revBuf.getChannelData(c);
          for (let i = 0; i < orig.length; i++) dest[i] = orig[orig.length - 1 - i];
        }
        this._workBuffer = revBuf;
      } else {
        const revBuf = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
        for (let c = 0; c < src.numberOfChannels; c++) {
          const orig = src.getChannelData(c);
          const dest = revBuf.getChannelData(c);
          for (let i = 0; i < orig.length; i++) dest[i] = orig[orig.length - 1 - i];
        }
        this._workBuffer = revBuf;
      }
      this._reversed = true;
    }

    // Mirror playhead position
    const mirroredTime = this._reversed ? this._duration - wasTime : wasTime;
    this._currentTime = Math.max(0, Math.min(this._duration, mirroredTime));
    this.emit();
    if (wasPlaying) this.play(this._currentTime);
  }
  get reversed() { return this._reversed; }

  /**
   * Normalizes the working buffer so the peak amplitude is 0 dBFS.
   * Applies on top of any existing reverse. Idempotent — calling again
   * re-normalizes (useful after other edits).
   */
  async normalize() {
    const src = this._workBuffer ?? this.buffer;
    if (!src) return;
    const wasPlaying = this._playing;
    const wasTime = this._currentTime;
    this.stop();

    // Find peak across all channels
    let peak = 0;
    for (let c = 0; c < src.numberOfChannels; c++) {
      const data = src.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const abs = Math.abs(data[i]);
        if (abs > peak) peak = abs;
      }
    }
    if (peak < 0.0001) { this.emit(); return; } // silence — nothing to do

    const scale = 1 / peak;
    // Build a new normalized buffer (don't mutate the original)
    const normBuf = (this.ctx ?? new AudioContext()).createBuffer(
      src.numberOfChannels, src.length, src.sampleRate
    );
    for (let c = 0; c < src.numberOfChannels; c++) {
      const orig = src.getChannelData(c);
      const dest = normBuf.getChannelData(c);
      for (let i = 0; i < orig.length; i++) dest[i] = orig[i] * scale;
    }
    this._workBuffer = normBuf;
    this._currentTime = wasTime;
    this.emit();
    if (wasPlaying) this.play(wasTime);
  }

  /**
   * Deletes the audio between `startSec` and `endSec` from the working buffer,
   * splicing the two surrounding sections together seamlessly.
   * After deletion the playhead is placed at the splice point.
   * Loop is turned off since the region no longer exists.
   */
  async deleteRegion(startSec: number, endSec: number) {
    const src = this._workBuffer ?? this.buffer;
    if (!src) return;
    const sr = src.sampleRate;
    const totalSamples = src.length;

    // Clamp to buffer bounds
    const s0 = Math.max(0, Math.round(startSec * sr));
    const s1 = Math.min(totalSamples, Math.round(endSec * sr));
    if (s1 <= s0) return; // nothing to delete

    const wasPlaying = this._playing;
    this.stop();

    const keepBefore = s0;           // samples [0, s0)
    const keepAfter  = totalSamples - s1; // samples [s1, end)
    const newLength  = keepBefore + keepAfter;
    if (newLength <= 0) return;

    const ctx = this.ctx ?? new AudioContext();
    const newBuf = ctx.createBuffer(src.numberOfChannels, newLength, sr);

    for (let c = 0; c < src.numberOfChannels; c++) {
      const orig = src.getChannelData(c);
      const dest = newBuf.getChannelData(c);
      // Copy the part before the deleted region
      dest.set(orig.subarray(0, s0), 0);
      // Copy the part after the deleted region
      dest.set(orig.subarray(s1), keepBefore);
    }

    this._workBuffer = newBuf;
    this._duration   = newBuf.duration;
    // Place playhead at the splice point (start of deleted region, now merged)
    this._currentTime = Math.min(startSec, newBuf.duration);
    // Clear loop — the selected region is gone
    this._loopOn    = false;
    this._loopStart = 0;
    this._loopEnd   = newBuf.duration;

    this.emit();
    if (wasPlaying) this.play(this._currentTime);
  }

  async setHighCut(hz: number) {
    this._highCutHz = hz;
    if (this.lowpass) this.lowpass.frequency.value = hz;
    this.emit();
  }
  get highCutHz() { return this._highCutHz; }

  async setLowCut(hz: number) {
    this._lowCutHz = hz;
    if (this.highpass) this.highpass.frequency.value = hz;
    this.emit();
  }
  get lowCutHz() { return this._lowCutHz; }

  async setLoop(on: boolean, start?: number, end?: number) {
    this._loopOn = on;
    if (start != null) this._loopStart = Math.max(0, start);
    if (end != null) this._loopEnd = Math.min(this._duration, end);
    if (this.source) {
      this.source.loop = on;
      this.source.loopStart = this._loopStart;
      this.source.loopEnd = this._loopEnd;
    }
    this.emit();
  }
  get loopOn() { return this._loopOn; }
  get loopStart() { return this._loopStart; }
  get loopEnd() { return this._loopEnd; }

  private startTicker() {
    this.stopTicker();
    this.ticker = window.setInterval(() => {
      if (!this.ctx || !this.source) return;
      let t = this.positionNow();
      if (this._loopOn && this._loopEnd > this._loopStart) {
        const len = this._loopEnd - this._loopStart;
        if (t > this._loopEnd) {
          t = this._loopStart + ((t - this._loopStart) % len);
        }
      }
      this._currentTime = Math.max(0, Math.min(this._duration, t));
      this.emit();
    }, 50);
  }
  private stopTicker() {
    if (this.ticker != null) {
      window.clearInterval(this.ticker);
      this.ticker = null;
    }
  }
  private stopSource() {
    const s = this.source;
    if (s) {
      this.source = null;
      s.onended = null;
      try { s.stop(); } catch { /* noop */ }
      s.disconnect();
    }
  }

  async unload() {
    this.stop();
    this.buffer = null;
    this._workBuffer = null;
    this._reversed = false;
    this._pitchSemitones = 0;
    this._loadedPath = null;
    this._duration = 0;
    this.emit();
  }

  /**
   * Renders the current edit offline with filters + rate + pitch + loop trim applied.
   * Uses the work buffer (reversed/normalized) when available.
   * When loop is on, renders just the loop region; otherwise the full buffer.
   */
  async renderEdit(): Promise<AudioBuffer | null> {
    const srcBuf = this._workBuffer ?? this.buffer;
    if (!srcBuf) return null;
    const srcDur = this._loopOn && this._loopEnd > this._loopStart
      ? this._loopEnd - this._loopStart
      : srcBuf.duration;
    // The export was always correct about this — it is the live playhead
    // that was not. Same helper now drives both.
    const effectiveRate = Math.max(0.01, this.effectiveRate());
    const outDur = srcDur / effectiveRate;
    const sampleRate = srcBuf.sampleRate;
    const channels = srcBuf.numberOfChannels;
    const OfflineCtor =
      window.OfflineAudioContext ||
      (window as Window & { webkitOfflineAudioContext?: typeof OfflineAudioContext })
        .webkitOfflineAudioContext;
    const offline = new OfflineCtor(channels, Math.ceil(outDur * sampleRate), sampleRate);
    const src = offline.createBufferSource();
    src.buffer = srcBuf;
    src.playbackRate.value = effectiveRate;
    const hp = offline.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = this._lowCutHz;
    const lp = offline.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = this._highCutHz;
    const g = offline.createGain();
    g.gain.value = this._volume;
    src.connect(hp).connect(lp).connect(g).connect(offline.destination);
    const startOffset = this._loopOn ? this._loopStart : 0;
    src.start(0, startOffset, srcDur);
    return offline.startRendering();
  }
  /**
   * The working buffer downmixed to mono, for drawing.
   *
   * A method rather than a buffer getter because the backend editor holds no
   * decoded audio in the webview at all — it fetches the downmix as bytes
   * when the shape on screen needs to change.
   */
  async monoSamples(): Promise<Float32Array | null> {
    const buf = this._workBuffer ?? this.buffer;
    if (!buf) return null;
    const channels = buf.numberOfChannels;
    if (channels === 1) return buf.getChannelData(0).slice();
    const out = new Float32Array(buf.length);
    for (let c = 0; c < channels; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < data.length; i++) out[i] += data[i] / channels;
    }
    return out;
  }

  /** Render the edit to a WAV on disk and return its path. */
  async exportEdit(filename: string): Promise<string | null> {
    const rendered = await this.renderEdit();
    if (!rendered) return null;
    const bytes = encodeWav(rendered);
    return invoke<string>('save_export', { filename, bytes: Array.from(bytes) });
  }
}

/**
 * One of two editors, chosen once — the same seam `audioEngine` uses.
 *
 * In the desktop app the audio, the edits and the export all happen in Rust.
 * Browser mode keeps the Web Audio editor, because the library is served
 * over the network there and the speakers attached to this process are not
 * the ones the listener is sitting in front of.
 */
export const editorEngine: EditorEngine | BackendEditor = isTauri
  ? new BackendEditor()
  : new EditorEngine();
