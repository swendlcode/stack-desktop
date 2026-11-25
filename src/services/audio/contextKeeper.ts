/**
 * The output context, and everything that keeps it alive.
 *
 * Split out of the engine because it is a different job from playing a
 * sample, and it is nearly all of the hard-won code: building the context,
 * watching for the interruption WebKit inflicts on it, telling a context that
 * is genuinely running from one that only says so, and standing up a
 * replacement when it is wedged. The engine above it just starts sources.
 *
 * Two rules, paid for several times over:
 *  - Never trust `ctx.state`. A context whose device has been taken reports
 *    'running' with a stopped clock. The clock is the only honest witness.
 *  - Never await a WebKit audio promise unbounded. `resume()` parks rather
 *    than rejecting, and an await behind a single-flight guard that never
 *    settles is an engine that stays dead until the app is restarted.
 *
 * And a third, which the logs forced and which the first one has to make room
 * for: the clock is an honest witness to the graph, not to the output. Across
 * every recorded blur/focus pair the context stays running and its clock
 * advances in lockstep with wall time, no recovery event has ever fired, and
 * the sound was still gone. Everything in `outputWitness.ts` exists because
 * nothing in here measured whether the render reached a device.
 */

import {
  CLOCK_PROBE_MS,
  CLOCK_STALL_MS,
  GUARD_WATCHDOG_MS,
  RESUME_ATTEMPTS,
  RESUME_RETRY_MS,
  RESUME_TIMEOUT_MS,
  START_VERIFY_MS,
} from './constants';
import { alog } from './diagnostics';
import { OutputWitness } from './outputWitness';
import { isRunning, settleWithin, userActivationActive } from './webkit';
import type { BufferCache } from './bufferCache';

/** What the keeper needs from the engine above it. */
export interface KeeperHooks {
  /** Stop whatever source is playing — its context is going away. */
  stopSource: () => void;
  /** The sample the engine is playing, if any. */
  currentPath: () => string | null;
  /** Is this ticket still what the user wants? */
  isCurrentTicket: (ticket: number) => boolean;
  /** A dead context has been replaced and is live again. */
  onRestored: () => void;
  /** A source started and was not heard. */
  onStartFailed: (path: string) => void;
  /** A source started, the clock moved, and the output carried no signal. */
  onSilentOutput: (path: string, peak: number, expected: number) => void;
  /** Loudest sample in the decoded buffer over the window a tap read covers. */
  expectedPeak: (path: string, sinceStartSec: number, windowSec: number) => number | null;
  /** Gain value for a freshly built node. */
  gainValue: () => number;
}

export class ContextKeeper {
  /** The live output context, or null when there is none. */
  ctx: AudioContext | null = null;
  /** The master gain every source connects to. Rebuilt with the context. */
  gain: GainNode | null = null;
  private globalListenersBound = false;
  // Set while the window is in the background. The context can be interrupted
  // out of sight — switching macOS Spaces is enough — so the next time the
  // user touches the app we re-check the clock rather than assume.
  private backgroundSinceLastCheck = false;
  // True once a context has existed. Distinguishes "torn down and owed a
  // replacement" from "the user has not played anything yet", so we never
  // build a context nobody asked for.
  private hadContext = false;
  // In-flight heal kicked off from a synchronous path.
  private healing: Promise<unknown> | null = null;
  // In-flight recovery, so overlapping app-switch events coalesce.
  private recovering: Promise<void> | null = null;
  // In-flight context construction, so concurrent callers share one context.
  private ctxInit: Promise<void> | null = null;
  // Last observed audio-clock value and the wall time it was observed at.
  private clockMark = { ctx: 0, wall: 0 };
  // Watches the signal rather than the clock: the output tap, the device
  // fingerprint and the idle re-arm. See outputWitness.ts for why.
  private witness = new OutputWitness();

  constructor(
    private buffers: BufferCache,
    private hooks: KeeperHooks,
  ) {}

  /**
   * Returns the AudioContext, creating it if needed.
   * Returns a Promise so callers can await resume() before starting a source.
   */
  async getCtxAsync(allowRebuild = true): Promise<AudioContext> {
    if (!this.ctx || this.ctx.state === 'closed') {
      // Coalesced. Recovery, a healing click and an ordinary play can all want
      // a context at the same moment; unguarded, each would construct its own
      // and the last writer would orphan the others — live contexts holding
      // the output device open with nothing able to close them.
      if (!this.ctxInit) {
        this.ctxInit = this.createContext().finally(() => {
          this.ctxInit = null;
        });
      }
      await this.ctxInit;
    }
    const ctx = this.ctx!;
    if (!isRunning(ctx)) {
      const before = ctx.state as string;
      // Bounded. An unbounded await here is the latch: WebKit parks the
      // promise instead of rejecting it, and this await is reached from the
      // recovery guard, the heal guard and every decode.
      const settled = await settleWithin(ctx.resume().catch(() => {}), RESUME_TIMEOUT_MS);
      alog('ctx:resume', { from: before, stateAfterResume: ctx.state, settled });
      // resume() resolving proves nothing. WebKit resolves it on an
      // 'interrupted' context and leaves the state exactly where it was, and
      // the source started next then plays into silence while every check
      // along the way reports success. Only the state afterwards counts.
      if (!isRunning(ctx) && allowRebuild) {
        alog('ctx:resume-ineffective', { ctxState: ctx.state });
        await this.rebuildContext(false);
        return this.getCtxAsync(false);
      }
    }
    // Deliberately NOT marking the clock here. This runs on paths that have
    // observed nothing — a decode, a heal — and refreshing the mark without
    // evidence is a forged alibi: `getCtxSync` compares wall time against the
    // last mark to catch a context whose clock has stopped, so a mark made
    // here made a dead context look alive on every subsequent click, which is
    // how the element kept being paused in favour of silence. The mark is
    // made only where the clock was actually seen to advance.
    return this.ctx!;
  }

  // Distinguishes one context from the next in the log. The first capture
  // showed `ctx:statechange {"ctxState":"closed"}` four milliseconds after a
  // replacement came up, which reads as the new context dying and is in fact
  // the old one finishing its close — the listeners are per-context and
  // nothing said which was speaking.
  private ctxSeq = 0;

  private async createContext(): Promise<void> {
    const Ctor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    // The device's own rate, and the platform's own idea of an interactive
    // buffer. Asking for anything else was a setting once; on WebKit the
    // latency hint is not even read, and naming a sample rate only forces a
    // resample between the file, the context and the hardware.
    try {
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      this.ctx = new Ctor();
    }
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.hooks.gainValue();
    // The key diagnostic: was the context born inside a user gesture? On WebKit
    // a context created without one can report 'running' yet stay muted.
    this.ctxSeq += 1;
    alog('ctx:construct', {
      ctx: this.ctxSeq,
      stateAfterCtor: this.ctx.state,
      sampleRate: this.ctx.sampleRate,
      userActivationActive: userActivationActive(),
    });
    // Buffers decoded for the previous context are still good as long as the
    // rate matches, and keeping them matters: a cache miss drops the next
    // click onto the HTML-audio path instead of the instant one.
    if (this.buffers.rate !== null && this.buffers.rate !== this.ctx.sampleRate) {
      this.buffers.clear();
    }
    this.buffers.rate = this.ctx.sampleRate;
    this.hadContext = true;
    // No evidence yet for this context. `wall: 0` means "never observed",
    // which `getCtxSync` reads as "do not accuse it of stalling"; the first
    // reader establishes the baseline and the stall check runs from there.
    this.clockMark = { ctx: 0, wall: 0 };
    this.wireOutput();
    this.watchContextState(this.ctx, this.ctxSeq);
    this.probeNewContext(this.ctx, this.ctxSeq);
    this.bindGlobalListeners();
  }

  /**
   * Per-context. Runs for EVERY context, including replacements built by
   * `rebuildContext` — a single "already bound" flag used to leave every
   * context after the first one unwatched.
   */
  private watchContextState(ctx: AudioContext, id: number) {
    ctx.addEventListener('statechange', () => {
      alog('ctx:statechange', { ctx: id, ctxState: ctx.state });
      if (this.ctx === ctx && !isRunning(ctx) && ctx.state !== 'closed') {
        ctx.resume().catch(() => {
          alog('ctx:auto-resume-failed', { ctxState: ctx.state });
        });
      }
    });
  }

  /**
   * Bound once per page: the app returning to the foreground, and the audio
   * devices changing underneath us.
   */
  private bindGlobalListeners() {
    if (this.globalListenersBound) return;
    this.globalListenersBound = true;

    // Coming back to the app is the moment before the user hits play. Note
    // that `visibilitychange` does NOT fire when another application merely
    // covers the window — the document stays visible — so `focus` is the
    // event that actually carries an app switch, which is the case that
    // matters here (a DAW in front, then back to Stack).
    window.addEventListener('blur', () => {
      this.backgroundSinceLastCheck = true;
      alog('app:blur', this.contextVitals());
    });
    window.addEventListener('focus', () => {
      alog('app:focus', this.contextVitals());
      void this.recoverOutput();
    });
    document.addEventListener('visibilitychange', () => {
      alog('app:visibility', { hidden: document.hidden, ...this.contextVitals() });
      if (document.hidden) this.backgroundSinceLastCheck = true;
      else void this.recoverOutput();
    });

    // Last line of defence. Switching macOS Spaces interrupts the context, and
    // the window does not reliably report that with a `focus` event — the user
    // comes back to a dead engine and clicks play. A pointer landing on the app
    // after any spell in the background re-checks before that click is handled;
    // the flag keeps the clock probe off the ordinary click path.
    window.addEventListener(
      'pointerdown',
      () => {
        // A pointer press is a user gesture, and a gesture is the one moment
        // WebKit reliably lets a context come back. Asking here — in the
        // capture phase, before any click handler runs — means the resume is
        // already in flight by the time the play lands, instead of the play
        // having to await it. This is the difference between an instant
        // audition and a short but noticeable one.
        const ctx = this.ctx;
        if (ctx && ctx.state !== 'closed' && !isRunning(ctx)) {
          ctx.resume().catch(() => {});
        }
        if (this.backgroundSinceLastCheck) void this.recoverOutput();
      },
      true
    );

    // A DAW opening or releasing the output device surfaces here. The context
    // is bound to the device it was built on, so this is the other moment
    // worth re-checking.
    try {
      navigator.mediaDevices?.addEventListener?.('devicechange', () => {
        alog('devices:change');
        void this.recoverOutput();
      });
    } catch {
      /* no mediaDevices in this webview */
    }
  }

  /** What the output looked like at this instant, for the log ring. */
  private contextVitals(): Record<string, unknown> {
    const ctx = this.ctx;
    return {
      ctxState: ctx?.state ?? 'none',
      ctxTime: ctx ? Number(ctx.currentTime.toFixed(3)) : null,
      // Recorded on both sides of every app switch. Until this was here the
      // log could not answer the one question that mattered on a refocus:
      // is this still the same output device?
      device: ctx ? this.witness.fingerprintOf(ctx) : null,
    };
  }

  /**
   * Watch a newly built context for half a second.
   *
   * This is the question no amount of reading the code can answer: is a
   * context built *after* the interruption audible at all? If its clock never
   * starts, no amount of work in here can fix this and playback has to leave
   * the webview. The answer lands in the log ring either way.
   */
  private probeNewContext(ctx: AudioContext, id: number) {
    const born = ctx.currentTime;
    [0, 100, 500].forEach((delay) => {
      window.setTimeout(() => {
        if (this.ctx !== ctx) return;
        alog('ctx:probe', {
          ctx: id,
          at: delay,
          ctxState: ctx.state,
          ctxTime: Number(ctx.currentTime.toFixed(4)),
        });
        // Identify the device here too, not only from a played sample.
        // Taking it only from a start left a context rebuilt while the user
        // was reading the list unidentified until they next clicked
        // something — ninety-one seconds of `verdict: unknown` in the first
        // capture, every one of them blind to a second device change. A clock
        // that has moved since construction is the same proof a start gives.
        if (delay === 500 && isRunning(ctx) && ctx.currentTime > born) {
          this.witness.confirm(ctx);
        }
      }, delay);
    });
  }

  /**
   * True while the context's clock is actually advancing.
   *
   * A context can sit in 'running' and still be dead: once another application
   * takes the output device, the clock stops, `start()` reports success and
   * nothing is heard. The state cannot tell those apart — the clock can.
   */
  private async isClockAdvancing(ctx: AudioContext): Promise<boolean> {
    const before = ctx.currentTime;
    await new Promise((resolve) => setTimeout(resolve, CLOCK_PROBE_MS));
    return ctx.currentTime > before;
  }

  /**
   * Resume a suspended context, and replace one that is wedged.
   *
   * This is the recovery path for the dropout after switching to a DAW and
   * back: the old code only ever called `resume()`, which cannot fix a context
   * whose device has gone away. Without the rebuild the app stayed silent
   * until it was restarted.
   */
  recoverOutput(): Promise<void> {
    // `focus`, `visibilitychange` and `pointerdown` can all land on the same
    // app switch. Two recoveries in flight would race over the rebuild — one
    // closing the context the other had just stood up.
    //
    // The watchdog is the other half of that. A guard is only a good idea
    // while the thing it guards can finish: this one used to be released in
    // a `.finally` alone, so a recovery that parked on a WebKit promise made
    // every later recovery a no-op for the rest of the session. Every await
    // inside is bounded now, and this releases the guard anyway if one of
    // them finds a way to hang regardless.
    if (!this.recovering) {
      const run = this.runRecovery().catch(() => {});
      this.recovering = run;
      const release = (reason: string) => {
        if (this.recovering !== run) return;
        this.recovering = null;
        if (reason !== 'done') alog('recovery:watchdog-released', { reason });
      };
      void run.then(() => release('done'));
      window.setTimeout(() => release('timeout'), GUARD_WATCHDOG_MS);
    }
    return this.recovering;
  }

  private async runRecovery(): Promise<void> {
    this.backgroundSinceLastCheck = false;
    const ctx = this.ctx;
    // Nothing to recover, but also nothing to play through: a previous
    // recovery may have torn the context down. Build the replacement now
    // rather than leaving the engine dead until something awaits it.
    if (!ctx || ctx.state === 'closed') {
      if (this.hadContext) await this.getCtxAsync().catch(() => {});
      return;
    }

    // Retry rather than resume once. WebKit interrupts and un-interrupts the
    // context around backgrounding, and a resume issued while that is in
    // flight resolves without changing the state — the reports on
    // webkit.org/b/240646 converge on "keep asking until it reads running".
    // A handful of attempts costs a few hundred ms on an app switch and saves
    // throwing away a context that was about to come back on its own.
    for (let attempt = 0; attempt < RESUME_ATTEMPTS && !isRunning(ctx); attempt += 1) {
      await settleWithin(ctx.resume().catch(() => {}), RESUME_TIMEOUT_MS);
      if (this.ctx !== ctx) return;
      if (isRunning(ctx)) break;
      await new Promise((resolve) => setTimeout(resolve, RESUME_RETRY_MS));
    }
    if (this.ctx !== ctx) return; // replaced while we were awaiting

    if (isRunning(ctx) && (await this.isClockAdvancing(ctx))) {
      if (this.ctx !== ctx) return;
      await this.checkOutputDevice(ctx);
      return;
    }
    if (this.ctx !== ctx) return;

    // The rebuild is no longer deferred. It was, to keep a click that landed
    // mid-recovery off the slow path — but `getCtxSync` now refuses a stalled
    // context outright, so that click was never going to reach the engine
    // anyway. All the deferral bought was most of a second of silence before
    // anything was heard at all.
    alog('ctx:wedged-rebuilding', { ctxState: ctx.state });
    await this.rebuildContext(false);
    // Stand the replacement up straight away. Leaving `ctx` null was the whole
    // bug behind "the sound disappears after a DAW, or after switching Spaces,
    // and never comes back": the only caller that builds a context is
    // `getCtxAsync`, and the hot play path goes through the synchronous
    // `playBuffer`, which never awaits anything. The engine stayed dead for the
    // rest of the session.
    await this.getCtxAsync().catch(() => {});

    // The engine deliberately does NOT restart anything here.
    //
    // It used to: it remembered whatever `currentPath` held when the
    // interruption hit and replayed it once the context was back. Nothing
    // checked that the user still wanted that sample, and `currentPath`
    // survives the entire time away because a stalled context never fires
    // `onended` — so coming back from ten minutes in a DAW and clicking a new
    // sample played the OLD one over it. That is the "wrong sample" report.
    //
    // Whether anything should be playing is the player's business, not the
    // engine's: only the store knows what is selected and whether the user
    // actually asked for sound.
    this.hooks.onRestored();
  }

  /**
   * The refocus path, for a context that is healthy by every old measure.
   *
   * This is where every app switch actually ends up, and until now it was a
   * bare `return`. The context is running, the clock is advancing, and the
   * report is still that the sound is gone — so the two things left to check
   * are the ones the clock cannot see.
   *
   * A changed fingerprint means the default output moved while the window was
   * away and this context is still bound to the device it was built on:
   * running, clocking, every start reported audible, nothing heard. That is
   * the only mechanism consistent with the whole log, and the rebuild is the
   * fix. Every recovery trigger written before this one keys off the clock,
   * which is why none of them has ever fired.
   */
  private async checkOutputDevice(ctx: AudioContext): Promise<void> {
    const verdict = this.witness.compare(ctx);
    if (verdict === 'changed') {
      alog('devices:changed', {
        was: this.witness.identity,
        now: this.witness.fingerprintOf(ctx),
      });
      await this.rebuildContext(false);
      await this.getCtxAsync().catch(() => {});
      this.hooks.onRestored();
      return;
    }
    // Logged rather than silent. This early return is the one every refocus
    // takes, and its invisibility is why four releases of work could look
    // like they were running when they never ran at all.
    alog('recovery:skipped', { reason: 'clock-advancing', verdict, ...this.contextVitals() });
    this.witness.rearm(ctx);
  }

  /**
   * Fire-and-forget context repair, callable from a synchronous path.
   *
   * Coalesced: a run of failing clicks must not stack up rebuilds on top of
   * each other, which would close the context the previous one just opened.
   */
  heal(): void {
    if (this.healing) return;
    const ctx = this.ctx;
    // A context that claims to be running needs its clock probed, not another
    // resume. `getCtxAsync` hands a 'running' context straight back without
    // touching it, so healing a stalled-but-running context through it was a
    // no-op that reported success — the one case this is most often called
    // for. `recoverOutput` probes the clock and rebuilds.
    const run = (ctx && isRunning(ctx)
      ? this.recoverOutput()
      : this.getCtxAsync().then(
          () => {},
          () => {},
        )
    ).catch(() => {});
    this.healing = run;
    const release = (reason: string) => {
      if (this.healing !== run) return;
      this.healing = null;
      if (reason !== 'done') alog('heal:watchdog-released', { reason });
    };
    void run.then(() => release('done'));
    window.setTimeout(() => release('timeout'), GUARD_WATCHDOG_MS);
  }

  /**
   * Record that the clock was seen at this value, now.
   *
   * Two timestamps are all a synchronous stall check needs: if wall time has
   * moved on and `ctx.currentTime` has not, the context is dead whatever it
   * claims its state is.
   */
  private markClock(ctx: AudioContext) {
    this.clockMark = { ctx: ctx.currentTime, wall: performance.now() };
  }

  /**
   * Confirm a source that has just started is actually being heard.
   *
   * `start()` succeeding proves nothing on WebKit — the documented failure is
   * a context that reports `running` while its clock is stopped. The
   * synchronous check in `getCtxSync` catches that from the *second* click
   * onward, because it needs a previous good sample to compare against; this
   * is what catches the first one. If the clock has not moved shortly after
   * starting, the context is dead: repair it and tell the player, which can
   * then route the sample somewhere audible.
   */
  verifyStarted(ctx: AudioContext, ticket: number) {
    const stillWanted = () => this.ctx === ctx && this.hooks.isCurrentTicket(ticket);
    this.witness.noteStart();
    const path = this.hooks.currentPath();
    // The clock check below answers "did the graph render?". This answers
    // "did anything come out?", which is the question four releases of
    // recovery work could not ask.
    if (path) {
      this.witness.watch(
        path,
        this.gain?.gain.value ?? 0,
        ctx.sampleRate,
        stillWanted,
        (since, windowSec) => this.hooks.expectedPeak(path, since, windowSec),
        (silentPath, peak, expected) =>
          this.hooks.onSilentOutput(silentPath, peak, expected),
      );
    }
    const before = ctx.currentTime;
    window.setTimeout(() => {
      if (!stillWanted()) return;
      if (ctx.currentTime > before) {
        this.markClock(ctx);
        // A start that was heard is the only honest moment to fingerprint the
        // device: `outputLatency` reads zero until something has actually
        // been rendered, so a baseline taken at construction is a false
        // device change waiting for the first app switch.
        this.witness.confirm(ctx);
        return;
      }
      alog('ctx:started-but-silent', { ctxState: ctx.state });
      const path = this.hooks.currentPath();
      this.hooks.stopSource();
      void this.recoverOutput();
      // Say so. This used to repair the engine silently and leave the player
      // showing a sample that was playing into nothing; the player can put
      // the sound somewhere audible now instead of waiting for a rebuild.
      if (path) this.hooks.onStartFailed(path);
    }, START_VERIFY_MS);
  }

  /** Synchronous accessor — only safe after getCtxAsync() has been awaited once. */
  getCtxSync(): AudioContext | null {
    // Anything other than 'running' means sources would start silently. In
    // particular WebKit has an 'interrupted' state (system audio interruption,
    // or the app sitting in the background for a long stretch) that is absent
    // from the DOM type union: treating it as usable produced a source that
    // reported success and played nothing, and because the engine then looked
    // "active", usePlayer trusted it and never fell back to HTML audio.
    if (!this.ctx || !isRunning(this.ctx)) {
      return null;
    }

    // `running` is still not proof — that is the whole premise of this engine,
    // and checking the state alone here quietly undid it. Once another app has
    // taken the device the clock stops while the state stays `running`, so
    // `playBuffer` started a source, returned TRUE, and `usePlayer` believed
    // the engine had it: no fallback, no sound, and a UI that read "playing"
    // over silence until recovery eventually replayed it most of a second
    // later. That is the whole of the reported delay.
    //
    // The check is two numbers rather than the 120ms probe `recoverOutput`
    // uses, because this sits on the click path and cannot await anything:
    // if wall time has advanced past the last good sample and the audio clock
    // has not moved with it, the context is stalled.
    const now = performance.now();
    const { ctx, wall } = this.clockMark;
    if (wall > 0 && now - wall > CLOCK_STALL_MS && this.ctx.currentTime <= ctx + 1e-4) {
      alog('ctx:clock-stalled', { ctxTime: this.ctx.currentTime, since: now - wall });
      this.heal();
      return null;
    }
    if (this.ctx.currentTime > ctx) this.markClock(this.ctx);
    return this.ctx;
  }

  /**
   * Connect the gain node to the output.
   *
   * One route. There used to be three — a device picked in Settings could be
   * reached either through `AudioContext.setSinkId` (Chromium) or through a
   * MediaStream into an `<audio>` element (WebKit). Choosing an output is no
   * longer a setting, so previews follow the system output the way every
   * other app's do, and the two indirections that each had their own failure
   * modes are gone with it.
   */
  private wireOutput(): void {
    if (!this.ctx || !this.gain) return;
    try { this.gain.disconnect(); } catch { /* nothing connected */ }
    // Not straight to the destination any more. The witness inserts its tap
    // here and connects the rest of the way, so every sample this app makes
    // passes something that can say whether it carried any signal at all.
    this.witness.attach(this.ctx, this.gain);
  }

  /**
   * Tear down the current context and decoded buffers so the next play rebuilds
   * with current preferences. Buffers are decoded at the old context's sample
   * rate, so they must be dropped when the rate changes.
   */
  async rebuildContext(dropBuffers = true): Promise<void> {
    this.hooks.stopSource();
    if (dropBuffers) {
      this.buffers.clear();
    } else {
      // In-flight decodes belong to the context that is going away; the
      // finished buffers do not, and they are dropped only if the replacement
      // comes up at a different rate.
      this.buffers.dropPending();
    }
    const old = this.ctx;
    this.ctx = null;
    this.gain = null;
    // The tap, the fingerprint and the idle mark all belong to the context
    // that is going away; the replacement establishes its own.
    this.witness.detach();
    if (old && old.state !== 'closed') {
      // Not awaited. Closing a context whose device has gone away can take as
      // long as it likes, and nothing downstream needs it finished — the
      // replacement is built independently. Awaiting it put another unbounded
      // WebKit promise inside the recovery guard.
      void old.close().catch(() => {});
    }
  }

  /**
   * Throw the context away and build a fresh one, ignoring every guard.
   *
   * This is the button that used to be "quit Stack and open it again". It
   * deliberately does not go through `recoverOutput`: the whole point is to
   * be usable when that is wedged.
   */
  async restart(): Promise<void> {
    alog('engine:manual-restart');
    this.recovering = null;
    this.healing = null;
    this.ctxInit = null;
    await this.rebuildContext(false);
    await this.getCtxAsync().catch(() => {});
    this.hooks.onRestored();
  }

  /** Is a repair in flight? */
  get repairing(): boolean {
    return this.recovering !== null || this.healing !== null;
  }

  /** Loudest sample currently crossing the output tap; null without one. */
  outputPeak(): number | null {
    return this.witness.peak();
  }

  /** The device this context proved itself on; null until a start was heard. */
  outputDevice(): string | null {
    return this.witness.identity;
  }

  /** How long since the clock was last seen to advance; null if never. */
  clockAgeMs(): number | null {
    return this.clockMark.wall > 0 ? Math.round(performance.now() - this.clockMark.wall) : null;
  }
}
