/**
 * The part of the engine that watches the signal instead of the clock.
 *
 * Everything else in here decides whether output is alive by reading
 * `ctx.currentTime`, on the doctrine that a context can lie about its state
 * but not about its clock. That doctrine is right about the failure it was
 * written for — a DAW taking the device stops the clock — and it is blind to
 * the other one.
 *
 * The evidence: across every recorded blur/focus pair in a week of logs, from
 * ten seconds in the background to five and a half minutes, the context stays
 * `running` and its clock advances by exactly the wall-clock gap. Not one
 * occurrence of a stalled clock, a wedged context or an ineffective resume.
 * After coming back, clicks report themselves audible in single-digit
 * milliseconds. Every measurement the app had said the output was healthy,
 * and the sound was gone.
 *
 * So the clock proves the graph is rendering. It does not prove the render
 * reaches a device, and nothing here measured the difference. These three
 * things do:
 *
 *  - a tap on the output that reads the actual signal, so a start that
 *    produced no samples is a recorded event rather than an absence;
 *  - a fingerprint of the device the context was built on, compared when the
 *    window comes back, because a default output that changed while the app
 *    was away leaves a context bound to a device that is no longer there —
 *    running, clocking, and inaudible;
 *  - a silent frame on refocus, because the first click after an idle spell
 *    measures 662, 669 and 909ms on this machine and the user reads most of a
 *    second of nothing as a click that did not work.
 */

import { REARM_IDLE_MS, SILENT_PEAK, SILENT_SHORTFALL, WITNESS_SAMPLES_MS } from './constants';
import { alog } from './diagnostics';

/** How the fingerprint comparison came out. */
export type DeviceVerdict = 'same' | 'changed' | 'unknown';

/**
 * Whatever this lib version says `getFloatTimeDomainData` takes. Newer DOM
 * typings parameterise `Float32Array` by its backing buffer and reject a
 * plainly-declared one; taking the type from the method keeps this working
 * either way.
 */
type TimeDomainBuffer = Parameters<AnalyserNode['getFloatTimeDomainData']>[0];

export class OutputWitness {
  /** Tap between the master gain and the destination. Rebuilt per context. */
  private analyser: AnalyserNode | null = null;
  private scratch: TimeDomainBuffer | null = null;
  /** The device this context proved itself on. Null until a start was heard. */
  private fingerprint: string | null = null;
  /** Wall time of the last real source start, for the idle re-arm. */
  private lastStartAt = 0;
  /** The start currently being watched. Finalized when another supersedes it. */
  private pending: {
    path: string;
    gain: number;
    peak: number;
    expected: number;
    reads: number;
    timers: number[];
    onSilent: (path: string, peak: number, expected: number) => void;
  } | null = null;

  /**
   * Insert the tap: gain → analyser → destination.
   *
   * An AnalyserNode is a pass-through — it copies what crosses it and changes
   * nothing — so this costs one node and no latency. If the context refuses
   * to make one, wire the output the old way and give up the witness rather
   * than the sound.
   */
  attach(ctx: AudioContext, gain: GainNode): void {
    this.detach();
    try {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      this.analyser = analyser;
      this.scratch = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      return;
    } catch {
      this.analyser = null;
      this.scratch = null;
    }
    gain.connect(ctx.destination);
  }

  /** Forget everything bound to a context that is going away. */
  detach(): void {
    this.finish('context-gone');
    this.analyser = null;
    this.scratch = null;
    this.fingerprint = null;
    this.lastStartAt = 0;
  }

  /** Loudest sample currently crossing the tap, or null without one. */
  peak(): number | null {
    const { analyser, scratch } = this;
    if (!analyser || !scratch) return null;
    try {
      analyser.getFloatTimeDomainData(scratch);
    } catch {
      return null;
    }
    let peak = 0;
    for (let i = 0; i < scratch.length; i += 1) {
      const v = scratch[i] < 0 ? -scratch[i] : scratch[i];
      if (v > peak) peak = v;
    }
    return peak;
  }

  /** The device this context last proved itself on, for diagnostics. */
  get identity(): string | null {
    return this.fingerprint;
  }

  /**
   * What the output device looks like from inside the webview.
   *
   * There is no device id to read: WKWebView will not hand one over without a
   * microphone permission this app has no business asking for, and
   * `devicechange` has never once fired in any recorded session. These four
   * numbers are properties of the device the context was built on, and they
   * move together when the default output changes. The logs already carried
   * the proof and nothing compared it — `outputLatency` reads 0.292ms across
   * one run of sessions and 15.833ms across another, which is two different
   * devices, recorded all along.
   */
  fingerprintOf(ctx: AudioContext): string {
    const out = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
    const q = (n: number | undefined) =>
      typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1e4) : -1;
    return [ctx.sampleRate, ctx.destination.maxChannelCount, q(ctx.baseLatency), q(out)].join('/');
  }

  /**
   * Record the device as proven, once per context.
   *
   * Taken from a start whose clock was seen to move, never at construction:
   * `outputLatency` reads zero until the device has actually rendered
   * something, so a baseline taken too early is a fingerprint change waiting
   * to happen on the first app switch.
   */
  confirm(ctx: AudioContext): void {
    if (this.fingerprint !== null) return;
    this.fingerprint = this.fingerprintOf(ctx);
    alog('devices:fingerprint', { fingerprint: this.fingerprint });
  }

  /** Is this still the device the context was built on? */
  compare(ctx: AudioContext): DeviceVerdict {
    if (this.fingerprint === null) return 'unknown';
    return this.fingerprintOf(ctx) === this.fingerprint ? 'same' : 'changed';
  }

  /** A real source started, now. Only this defers the idle re-arm. */
  noteStart(): void {
    this.lastStartAt = performance.now();
  }

  /**
   * Watch what the output actually carried after a start.
   *
   * Sampled several times rather than once, because a one-shot can be over
   * before a single late read and a pad can be below the floor through an
   * early one. The peak across the window is the answer, and it is logged
   * whether or not it is bad: a healthy run of peaks is what makes a silent
   * one legible when it finally shows up in somebody's log.
   *
   * Measured against the sample's own level, not against zero. The first
   * capture made the case for itself — the only start this ever flagged was a
   * 53-second loop whose first 700ms are digital silence, which the tap read
   * as 0 and was right to. `expectedAt` answers what should have been crossing
   * the tap at each read, from the decoded buffer at the offset the source
   * actually started from, so the test is a shortfall rather than an absence.
   * That is also the stronger test: a loud sample arriving 50 dB down is a
   * failure an absolute floor would wave through.
   */
  watch(
    path: string,
    gainValue: number,
    sampleRate: number,
    stillWanted: () => boolean,
    expectedAt: (sinceStartSec: number, windowSec: number) => number | null,
    onSilent: (path: string, peak: number, expected: number) => void,
  ): void {
    const analyser = this.analyser;
    // Whatever was being watched is over the moment another sample starts —
    // report what it managed to gather rather than dropping it. Waiting for
    // the full window to elapse meant the witness said nothing at all through
    // an entire session of ordinary browsing: every start was superseded
    // inside 200ms, the last read never ran, and the one failure this exists
    // to catch would have gone unrecorded exactly when it was happening.
    this.finish('superseded');
    if (!analyser) return;
    // Silence is only meaningful against a gain that could have carried
    // something. At volume zero there is nothing to witness.
    if (gainValue <= 0) return;
    // A read returns the last `fftSize` frames, so each one covers that much
    // of the sample and nothing between reads. The expected peak is taken
    // over the same spans, or the two numbers are not comparable.
    const windowSec = analyser.fftSize / sampleRate;
    const last = WITNESS_SAMPLES_MS.length - 1;
    const pending = {
      path,
      gain: gainValue,
      peak: 0,
      expected: 0,
      reads: 0,
      timers: [] as number[],
      onSilent,
    };
    this.pending = pending;
    pending.timers = WITNESS_SAMPLES_MS.map((delay, index) =>
      window.setTimeout(() => {
        if (this.pending !== pending) return;
        // The analyser carries whatever is crossing it now, so once this
        // start is no longer the one playing a read would measure something
        // else. Close the books on what was seen while it still was.
        if (!stillWanted()) {
          this.finish('abandoned');
          return;
        }
        const level = this.peak();
        if (level === null) return;
        pending.reads += 1;
        if (level > pending.peak) pending.peak = level;
        const want = expectedAt(delay / 1000, windowSec);
        if (want !== null && want > pending.expected) pending.expected = want;
        if (index === last) this.finish('complete');
      }, delay),
    );
  }

  /** Report whatever the in-flight watch gathered, and stop watching. */
  private finish(reason: 'complete' | 'superseded' | 'abandoned' | 'context-gone'): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.timers.forEach((t) => window.clearTimeout(t));
    if (pending.reads === 0) return;
    const target = pending.expected * pending.gain;
    const silent = target >= SILENT_PEAK && pending.peak * SILENT_SHORTFALL < target;
    alog('output:witness', {
      path: pending.path,
      peak: Number(pending.peak.toFixed(5)),
      target: Number(target.toFixed(5)),
      reads: pending.reads,
      reason,
      silent,
    });
    if (silent) pending.onSilent(pending.path, pending.peak, target);
  }

  /**
   * Spend a render quantum of silence to wake the device.
   *
   * The first click after an idle spell measures 662, 669 and 909ms in the
   * recorded logs: the context is alive and the clock is moving, and CoreAudio
   * still takes most of a second to produce the first sound. Refocusing the
   * window is the moment before the click, so pay it there. Connected to the
   * destination directly, past the tap, so it cannot be mistaken for signal.
   */
  rearm(ctx: AudioContext): void {
    if (this.lastStartAt > 0 && performance.now() - this.lastStartAt < REARM_IDLE_MS) return;
    try {
      const source = ctx.createBufferSource();
      source.buffer = ctx.createBuffer(1, 128, ctx.sampleRate);
      source.connect(ctx.destination);
      source.start();
      alog('output:rearm', { ctxTime: Number(ctx.currentTime.toFixed(3)) });
    } catch {
      /* a context that refuses a silent frame has worse problems than latency */
    }
  }
}
