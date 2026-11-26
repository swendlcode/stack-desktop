import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { convertFileSrc } from '@tauri-apps/api/core';
import { usePlayerStore } from '../stores/playerStore';
import { useUiStore } from '../stores/uiStore';
import { assetService } from '../services/assetService';
import { settingsService } from '../services/settingsService';
import { audioEngine } from '../services/audioEngine';
import type { Asset, MidiMeta, MidiNote, Settings } from '../types';

function midiToFrequency(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

function getMidiDurationSeconds(notes: MidiNote[], fallbackMs: number | null): number {
  if (fallbackMs && fallbackMs > 0) return fallbackMs / 1000;
  const maxTick = notes.reduce((max, n) => Math.max(max, n.startTick + n.durationTicks), 0);
  if (maxTick === 0) return 8;
  return 8;
}

function getMidiTiming(notes: MidiNote[], durationSec: number) {
  const maxTick = notes.reduce((max, n) => Math.max(max, n.startTick + n.durationTicks), 0);
  const tickToSec = maxTick > 0 ? durationSec / maxTick : 0;
  return { maxTick, tickToSec };
}

type ScheduledMidiNote = {
  note: MidiNote;
  startSec: number;
  playDurationSec: number;
  velocity: number;
};

/**
 * Select playable MIDI voices for dense passages.
 * - Keeps a bounded number of simultaneous voices.
 * - Prioritizes louder notes when a chord exceeds the cap.
 */
function selectPlayableMidiNotes(
  notes: MidiNote[],
  durationSec: number,
  offsetSec: number,
  maxVoices: number
): ScheduledMidiNote[] {
  const { tickToSec } = getMidiTiming(notes, durationSec);
  if (tickToSec <= 0) return [];

  const normalized: ScheduledMidiNote[] = [];
  for (const note of notes) {
    const noteStart = note.startTick * tickToSec;
    const noteDuration = Math.max(0.03, note.durationTicks * tickToSec);
    const noteEnd = noteStart + noteDuration;
    if (noteEnd <= offsetSec) continue;
    const startSec = Math.max(0, noteStart - offsetSec);
    const cutAtStart = Math.max(0, offsetSec - noteStart);
    const playDurationSec = Math.max(0.02, noteDuration - cutAtStart);
    const velocityNorm = Math.max(0.05, Math.min(1, note.velocity / 127));
    const velocity = 0.12 + Math.pow(velocityNorm, 1.35) * 0.52;
    normalized.push({ note, startSec, playDurationSec, velocity });
  }

  normalized.sort((a, b) => a.startSec - b.startSec || b.velocity - a.velocity);

  const chosen: ScheduledMidiNote[] = [];
  type ActiveVoice = { endSec: number; velocity: number; chosenIndex: number; alive: boolean };
  const active: ActiveVoice[] = [];

  for (const candidate of normalized) {
    // Purge finished voices.
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].endSec <= candidate.startSec) active.splice(i, 1);
    }

    if (active.length < maxVoices) {
      const chosenIndex = chosen.length;
      chosen.push(candidate);
      active.push({
        endSec: candidate.startSec + candidate.playDurationSec,
        velocity: candidate.velocity,
        chosenIndex,
        alive: true,
      });
      continue;
    }

    // Replace the weakest currently active voice if this one is stronger.
    let weakestIdx = 0;
    for (let i = 1; i < active.length; i++) {
      if (active[i].velocity < active[weakestIdx].velocity) weakestIdx = i;
    }
    if (candidate.velocity <= active[weakestIdx].velocity) {
      continue;
    }
    const weakest = active[weakestIdx];
    weakest.alive = false;
    chosen[weakest.chosenIndex] = {
      ...chosen[weakest.chosenIndex],
      playDurationSec: 0,
    };
    const chosenIndex = chosen.length;
    chosen.push(candidate);
    active[weakestIdx] = {
      endSec: candidate.startSec + candidate.playDurationSec,
      velocity: candidate.velocity,
      chosenIndex,
      alive: true,
    };
  }

  return chosen.filter((n) => n.playDurationSec > 0);
}

/**
 * Wires the audioEngine and MIDI synth to the player store.
 *
 * Key design rules that prevent race conditions:
 *
 * 1. A single `useEffect([currentAsset, isPlaying])` handles ALL playback
 *    decisions. Splitting into two effects (one for asset, one for isPlaying)
 *    creates a window where both fire in the same React batch and race.
 *
 * 2. The effect captures a `generation` counter at entry. Any async operation
 *    (buffer decode, MIDI load) checks `generation` before acting — if the
 *    asset or play state changed while we were awaiting, we bail out.
 *
 * 3. `fallbackActiveRef` is cleared immediately when the asset changes, before
 *    any async work, so stale ensureBuffer callbacks can't hijack playback.
 *
 * 4. `audioEngine.playBuffer()` is synchronous on the hot path (arrow keys).
 *    The effect detects that audio is already playing the right asset and skips
 *    re-starting it, avoiding double-play.
 */
export function usePlayer() {
  const qc = useQueryClient();

  // Observe settings directly here so the auto-play-next decision never depends
  // on another hook (e.g. useTheme) having populated the ['settings'] cache.
  // PlayerBar is an observer, so the query is always fetched and kept fresh.
  const { data: playerSettings } = useQuery<Settings>({
    queryKey: ['settings'],
    queryFn: () => settingsService.getSettings(),
    staleTime: 30_000,
  });
  // Mirror into a ref so end-of-track callbacks read the latest value without
  // being re-created or capturing a stale closure.
  const autoPlayNextRef = useRef(false);
  autoPlayNextRef.current = playerSettings?.autoPlayNext ?? false;

  // Fallback HTML audio element — only used when buffer isn't cached yet
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fallbackActiveRef = useRef(false);
  // Which path the fallback element currently has loaded, and a seek waiting
  // for its metadata to arrive.
  const fallbackSrcRef = useRef<string | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  /** The object URL the element is holding, so it can be released. */
  const fallbackUrlRef = useRef<string | null>(null);
  /** The path whose blob has finished loading into the element. */
  const fallbackReadyRef = useRef<string | null>(null);
  /** What the element has been asked to play, if anything. */
  const fallbackWantRef = useRef<{ path: string; offset: number } | null>(null);

  /**
   * Get the HTML element ready to play `path` without actually playing it.
   *
   * The fallback used to set `src` and call `load()` at the moment of the
   * click, so every play it handled arrived audibly late — which is what the
   * engine failing over to it sounds like from the outside: not silence, lag.
   * Loading on selection instead means the element is already buffered by the
   * time it is needed, and the handover costs nothing when it isn't.
   */
  /**
   * Silence the HTML element and forget any seek queued for it.
   *
   * Exactly one of the two paths may be making sound. Nothing used to stop
   * the element when the engine took over, so after one fallback play the
   * element kept going underneath every later sample — you heard the old one
   * over the new, its clock drove the playhead, and its `ended` paused or
   * skipped whatever was actually selected.
   */
  const stopFallback = () => {
    pendingSeekRef.current = null;
    fallbackWantRef.current = null;
    // Pause unconditionally. `fallbackActiveRef` only goes true once the
    // element has reached `playing`, so it is still false for a `play()` that
    // is already in flight — and returning early on that was how a sample
    // ended up starting twice: the decode won the race, the engine started,
    // nothing stopped the element, and its sound arrived ~20ms behind the
    // engine's. Two copies of the same hit, slightly apart, which on a drum
    // fill is a flam and on a loop is comb filtering. Pausing an element that
    // is already paused costs nothing.
    audioRef.current?.pause();
    fallbackActiveRef.current = false;
  };

  /**
   * Load `path` into the element — as a blob, not as an asset URL.
   *
   * This is the correction to a false assumption the whole fallback was built
   * on. `convertFileSrc` returns an `asset://` URL, and WKWebView's media
   * loader cannot read custom schemes: `fetch` can (which is why decoding has
   * always worked) but `<audio>` cannot. Every single element start this app
   * has ever attempted was refused with `NotSupportedError` — the log says so,
   * 0 successes against 2 recorded refusals, and the refusal was silent until
   * an hour ago. The "safety net" was a sure thing that never caught anything.
   *
   * The bytes are fetched the same way the decoder fetches them, which is
   * proven to work, and handed to the element as an object URL, which it can
   * read. Loading on selection rather than at the click keeps the handover
   * free when it is needed.
   */
  const primeFallback = (path: string) => {
    const audio = audioRef.current;
    if (!audio || fallbackSrcRef.current === path) return;
    // A seek queued for the previous file would otherwise be applied to this
    // one on its `loadedmetadata`, starting it at the wrong place.
    pendingSeekRef.current = null;
    fallbackSrcRef.current = path;
    fallbackReadyRef.current = null;
    void (async () => {
      try {
        const res = await fetch(convertFileSrc(path));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        // Another sample was selected while this was loading.
        if (fallbackSrcRef.current !== path) return;
        const url = URL.createObjectURL(blob);
        if (fallbackUrlRef.current) URL.revokeObjectURL(fallbackUrlRef.current);
        fallbackUrlRef.current = url;
        audio.src = url;
        audio.load();
        fallbackReadyRef.current = path;
        const want = fallbackWantRef.current;
        if (want && want.path === path) playFallbackRef.current(want.path, want.offset);
      } catch (err) {
        // Unlatch, or this sample can never be loaded into the element again.
        // `fallbackSrcRef` is set before the fetch so a second call for the
        // same path does not start a second read; on failure it has to be
        // released, otherwise every later `startFallback(path)` finds the
        // path already "primed", never retries, and never plays — and when
        // the engine is also down that is permanent silence on that one
        // sample for the rest of the session.
        if (fallbackSrcRef.current === path) fallbackSrcRef.current = null;
        audioEngine.note('element:load-failed', { path, err: String(err) });
      }
    })();
  };

  /** Actually press play on the element, once it has something to play. */
  const playFallbackNow = (path: string, offset: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    // The engine may have won the race while the blob was loading.
    if (audioEngine.isPlayingPath(path)) {
      fallbackWantRef.current = null;
      return;
    }
    audio.volume = volumeRef.current;
    // Seeking before the element has metadata is ignored, so hold the offset
    // until `loadedmetadata` if it is not ready yet.
    if (audio.readyState > 0) {
      try {
        audio.currentTime = offset;
      } catch {
        pendingSeekRef.current = offset;
      }
    } else if (offset > 0) {
      pendingSeekRef.current = offset;
    }
    audio
      .play()
      .then(() => {
        // Claiming the sample before it was playing is what made a refused
        // element start fatal: `fallbackActiveRef` going true cancelled the
        // engine's start — `playAsync:no-longer-wanted` in the log — and then
        // the element failed, so neither route made a sound and the app was
        // silent until it was restarted. The claim now follows the sound.
        if (audioEngine.isPlayingPath(path)) {
          audio.pause();
          // And give the claim up with the sound. Leaving `fallbackActiveRef`
          // true here — set a moment earlier by the `playing` event — left a
          // *paused* element holding the sample, which disarms the two paths
          // that exist to rescue a silent click (`onStartFailed` and
          // `onContextRestored` both bail when the element claims it) and
          // sends a seek into an element that is not playing. A click after
          // that produced no sound at all.
          fallbackActiveRef.current = false;
          fallbackWantRef.current = null;
          return;
        }
        fallbackActiveRef.current = true;
      })
      .catch((err: unknown) => {
        fallbackActiveRef.current = false;
        audioEngine.note('element:refused', {
          path,
          err: err instanceof Error ? err.name : String(err),
        });
        // Only if nothing is making this sound already.
        //
        // The handback below assumes the element took the sample and the
        // engine let go of it. That is not the only way to get here: when a
        // decode lands while the element is still loading, the engine starts
        // the sample AND the element's `play()` is aborted by the handover,
        // one millisecond apart — and this then restarted a sample that was
        // already playing. Two `playSync:start` / `playAsync:start` pairs two
        // milliseconds apart in the capture, which is the retrigger behind
        // the double-sample report.
        if (audioEngine.isPlayingPath(path)) return;
        // Hand it back. The engine was told this sample was no longer wanted
        // the moment the element took it, so nothing is holding it any more —
        // and by now its context has usually finished resuming.
        const state = usePlayerStore.getState();
        if (state.currentAsset?.path !== path || !state.isPlaying) return;
        audioEngine
          .playBufferAsync(path, offset, () => {
            const live = usePlayerStore.getState();
            return live.currentAsset?.path === path && live.isPlaying;
          })
          .catch(() => {});
      });
  };
  const playFallbackRef = useRef(playFallbackNow);
  playFallbackRef.current = playFallbackNow;

  /**
   * Put a sample through the HTML element.
   *
   * The engine's path and this one both exist because either can be the only
   * one working: the element does not depend on an AudioContext, so it keeps
   * making sound through exactly the WebKit interruption that kills the
   * engine. This is the single place that starts it, so every caller gets the
   * same pending-seek handling and the same honest `fallbackActiveRef`.
   */
  const startFallback = (path: string, offset: number) => {
    // Every route to the element passes through here, which is why the
    // guard lives here rather than at each of the six call sites.
    if (!audioEngine.elementFallback) return;
    if (!audioRef.current) return;
    fallbackWantRef.current = { path, offset };
    primeFallback(path);
    // Already loaded — the usual case, because selecting the sample primed it.
    if (fallbackReadyRef.current === path) playFallbackNow(path, offset);
  };
  // Callbacks registered once would otherwise close over the first render's
  // copy of this.
  const startFallbackRef = useRef(startFallback);
  startFallbackRef.current = startFallback;

  // Shared AudioContext for MIDI — reused across plays to avoid the browser's
  // ~6 context limit. Closed only when the hook unmounts.
  const midiCtxRef = useRef<AudioContext | null>(null);
  const midiMasterRef = useRef<GainNode | null>(null);
  const midiTickerRef = useRef<number | null>(null);
  const midiEndTimerRef = useRef<number | null>(null);
  const midiStartedAtRef = useRef(0);
  const midiOffsetRef = useRef(0);
  const midiDurationRef = useRef(0);
  const midiNotesRef = useRef<MidiNote[]>([]);
  const midiAssetIdRef = useRef<string | null>(null);

  // Monotonically increasing counter — incremented on every asset/isPlaying change.
  // Async callbacks capture the value at their start and bail if it changed.
  const generationRef = useRef(0);

  // Track the last asset ID so we can detect asset switches vs pause/resume
  const currentAssetIdRef = useRef<string | null>(null);

  // Stable refs so effects don't re-run when these change
  const volumeRef = useRef(0.8);
  const pausedAtRef = useRef(0); // where we paused for the current sample
  // How long the engine gets to make a sound before the element is used
  // instead. Short enough that it cannot be heard as a delay, long enough for
  // a context resumed inside the click to come back on its own.
  //
  // 70ms was measured to be just too tight. Both recorded silences have the
  // same shape: no context at all, one constructed, and `ctx:resume` settling
  // ~90ms later — twenty milliseconds after the element had already been
  // handed the sample. The engine is the better route when it can take it at
  // all (no second decode, no second copy of the file), so it gets past where
  // a resume actually lands. Still under the 150ms that counts as slow.
  const ENGINE_GRACE_MS = 120;
  // When the user last actually asked for sound. A context that comes back
  // minutes later must not resurrect what was playing when it went away.
  const playRequestedAtRef = useRef(0);

  /**
   * Is this engine start still the one the user wants, right now?
   *
   * Handed to every asynchronous start. A start that parks on a context
   * resume can wake up long after the user has moved on, and the engine's own
   * ticket cannot see a click it never received — only the store knows what
   * is selected and whether it is meant to be playing.
   */
  const stillWanted = (assetId: string, gen: number) => () => {
    if (generationRef.current !== gen) return false;
    const state = usePlayerStore.getState();
    return state.currentAsset?.id === assetId && state.isPlaying;
  };
  // Last `stopSeq` acted on, so a stop can be told apart from a pause.
  const stopSeqRef = useRef(0);
  // Last `playSeq` acted on, so an explicit play request can be told apart
  // from the asset merely changing underneath. See the block in the sample
  // branch below for which of the two owns the start offset.
  const playSeqRef = useRef(0);

  const {
    currentAsset,
    isPlaying,
    volume,
    setCurrentTime,
    setDuration,
    pause,
    registerSeek,
  } = usePlayerStore();

  const editorAssetId = useUiStore((s) => s.editorAssetId);

  // Ref so end-of-track callbacks always call the latest version without
  // being listed as effect dependencies (avoids stale closure + re-runs).
  const handleTrackEndRef = useRef<() => void>(() => {});
  handleTrackEndRef.current = () => {
    // A sample that played to its end has no resume point. Both end routes —
    // the engine's `onended` and the element's — arrive here, and both used
    // to leave the last waveform click sitting in the resume slot: click into
    // a sample at 3.2s, let it finish, press play on the row, and it starts
    // at 3.2 again instead of at the beginning (issue #14). Stop looked like
    // the cure only because stop is the one path that already cleared this.
    //
    // It is the same rule `startOffsetFor` applies to an offset past the end,
    // one moment earlier: the playhead is at the end, and "play" there means
    // play it again.
    pausedAtRef.current = 0;
    // Read the live setting from the ref (fed by the settings query above), with
    // the query cache as a backup. Either way this no longer silently fails when
    // the cache happens to be empty.
    const autoPlayNext =
      autoPlayNextRef.current ||
      qc.getQueryData<Settings>(['settings'])?.autoPlayNext === true;
    if (autoPlayNext) {
      const { currentAsset, playlist, play } = usePlayerStore.getState();
      const idx = currentAsset
        ? playlist.findIndex((a) => a.id === currentAsset.id)
        : -1;
      const next = playlist[idx + 1];
      if (next) {
        if (next.type === 'sample') audioEngine.playBuffer(next.path, 0);
        play(next);
        audioEngine.prefetchAround(playlist, idx + 1);
        return;
      }
    }
    pause();
  };

  // ─── Volume sync (no playback side-effects) ────────────────────────────

  useEffect(() => {
    volumeRef.current = volume;
    audioEngine.setVolume(volume);
    if (audioRef.current) audioRef.current.volume = volume;
    if (midiMasterRef.current) midiMasterRef.current.gain.value = volume;
  }, [volume]);

  // ─── MIDI helpers ──────────────────────────────────────────────────────

  const stopMidiTimers = () => {
    if (midiTickerRef.current != null) {
      window.clearInterval(midiTickerRef.current);
      midiTickerRef.current = null;
    }
    if (midiEndTimerRef.current != null) {
      window.clearTimeout(midiEndTimerRef.current);
      midiEndTimerRef.current = null;
    }
  };

  // True while the backend is the one sounding the MIDI, so the stop and
  // pause paths know which engine they are talking to.
  const midiOnBackendRef = useRef(false);

  const stopMidiNodes = () => {
    if (midiOnBackendRef.current) {
      midiOnBackendRef.current = false;
      audioEngine.stop();
    }
    stopMidiTimers();
    // Disconnect master gain to silence all scheduled oscillators immediately
    if (midiMasterRef.current) {
      try { midiMasterRef.current.disconnect(); } catch { /* already disconnected */ }
      midiMasterRef.current = null;
    }
    // Close and replace the context so all scheduled nodes are garbage-collected.
    // We reuse a single context per session — just suspend it rather than close,
    // to avoid the browser's AudioContext instance limit.
    const ctx = midiCtxRef.current;
    if (ctx && ctx.state !== 'closed') {
      ctx.suspend().catch(() => {});
    }
    // Don't null out midiCtxRef — we'll resume it on next MIDI play
  };

  const pauseMidi = () => {
    if (midiOnBackendRef.current) {
      // The backend reports an absolute playhead — the performance is
      // rendered from the top and started partway in — so there is no
      // elapsed-since-start arithmetic to do here.
      midiOffsetRef.current = Math.min(
        midiDurationRef.current,
        audioEngine.getCurrentTime(),
      );
      stopMidiNodes();
      setCurrentTime(midiOffsetRef.current);
      return;
    }
    const ctx = midiCtxRef.current;
    if (ctx && ctx.state === 'running') {
      const elapsed = Math.max(0, ctx.currentTime - midiStartedAtRef.current);
      midiOffsetRef.current = Math.min(
        midiDurationRef.current,
        midiOffsetRef.current + elapsed
      );
    }
    stopMidiNodes();
    setCurrentTime(midiOffsetRef.current);
  };

  const getMidiCtx = async (): Promise<AudioContext> => {
    const AudioCtor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!midiCtxRef.current || midiCtxRef.current.state === 'closed') {
      midiCtxRef.current = new AudioCtor();
    }
    if (midiCtxRef.current.state === 'suspended') {
      await midiCtxRef.current.resume();
    }
    return midiCtxRef.current;
  };

  // One shared noise buffer for every hammer transient.
  const noiseBufferRef = useRef<AudioBuffer | null>(null);
  const getNoiseBuffer = (ctx: AudioContext) => {
    if (!noiseBufferRef.current) {
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.12), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      noiseBufferRef.current = buf;
    }
    return noiseBufferRef.current;
  };

  const scheduleMidiNotes = async (
    notes: MidiNote[],
    durationSec: number,
    offsetSec: number
  ): Promise<boolean> => {
    if (!notes.length) return false;
    const ctx = await getMidiCtx();
    const MAX_MIDI_VOICES = 24;

    // Create a fresh master gain for this play session
    const master = ctx.createGain();
    // Keep significant headroom for dense MIDI chords.
    master.gain.value = volumeRef.current * 0.9;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 12;
    limiter.ratio.value = 3;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    midiMasterRef.current = master;
    midiStartedAtRef.current = ctx.currentTime;

    const playable = selectPlayableMidiNotes(notes, durationSec, offsetSec, MAX_MIDI_VOICES);
    if (!playable.length) return false;

    // Second pass to estimate concurrent voices and apply polyphony gain compensation.
    const activeEndTimes: number[] = [];
    for (const entry of playable) {
      const startDelay = entry.startSec;
      const playDuration = entry.playDurationSec;
      const velocity = entry.velocity;
      const startAt = ctx.currentTime + startDelay;
      const stopAt = startAt + playDuration;
      const freq = midiToFrequency(entry.note.pitch);

      for (let i = activeEndTimes.length - 1; i >= 0; i--) {
        if (activeEndTimes[i] <= entry.startSec) activeEndTimes.splice(i, 1);
      }
      activeEndTimes.push(entry.startSec + playDuration);
      const activeVoices = activeEndTimes.length;
      // Chords should still sound like chords: compensate enough to avoid
      // clipping, not so much that a four-note voicing halves in level.
      const polyComp = Math.max(0.55, 1 / Math.pow(Math.max(1, activeVoices), 0.35));

      // Struck-string voice: a stack of harmonics whose upper partials fade
      // faster than the fundamental, which is what makes a piano read as a
      // piano rather than an organ. Slight inharmonicity (real strings are
      // stiff, so partials sit progressively sharp) keeps chords from
      // sounding synthetic.
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, startAt);
      env.gain.exponentialRampToValueAtTime(Math.max(0.05, 0.95 * velocity), startAt + 0.006);
      env.gain.exponentialRampToValueAtTime(Math.max(0.03, 0.42 * velocity), startAt + 0.18);
      env.gain.exponentialRampToValueAtTime(Math.max(0.015, 0.2 * velocity), startAt + 0.7);
      env.gain.exponentialRampToValueAtTime(0.0001, stopAt + 0.3);

      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.setValueAtTime(Math.min(11000, 3200 + freq * 3.2), startAt);
      tone.Q.value = 0.3;
      tone.connect(env);
      env.connect(master);

      const PARTIALS = [
        { mult: 1, gain: 0.62, decay: 1.0 },
        { mult: 2, gain: 0.26, decay: 0.62 },
        { mult: 3, gain: 0.13, decay: 0.45 },
        { mult: 4, gain: 0.08, decay: 0.32 },
        { mult: 5, gain: 0.05, decay: 0.24 },
        { mult: 6, gain: 0.03, decay: 0.18 },
      ];
      const inharmonicity = 0.0004;

      for (const partial of PARTIALS) {
        const pf = freq * partial.mult * (1 + inharmonicity * partial.mult * partial.mult);
        if (pf > 16000) continue;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(pf, startAt);
        // A few cents of detune per partial gives the gentle beating of real strings.
        osc.detune.setValueAtTime((partial.mult - 1) * 1.6, startAt);

        const pg = ctx.createGain();
        const peak = Math.max(0.0002, partial.gain * polyComp);
        pg.gain.setValueAtTime(0.0001, startAt);
        pg.gain.exponentialRampToValueAtTime(peak, startAt + 0.005);
        // Upper partials die away first.
        const partialEnd = startAt + Math.max(0.12, (stopAt - startAt + 0.3) * partial.decay);
        pg.gain.exponentialRampToValueAtTime(0.0001, partialEnd);

        osc.connect(pg);
        pg.connect(tone);
        osc.start(startAt);
        osc.stop(stopAt + 0.32);
      }

      // Hammer strike: a very short filtered noise burst that supplies the
      // transient the oscillator stack alone cannot.
      const strike = ctx.createBufferSource();
      strike.buffer = getNoiseBuffer(ctx);
      const strikeFilter = ctx.createBiquadFilter();
      strikeFilter.type = 'bandpass';
      strikeFilter.frequency.setValueAtTime(Math.min(7000, freq * 4), startAt);
      strikeFilter.Q.value = 0.8;
      const strikeGain = ctx.createGain();
      strikeGain.gain.setValueAtTime(0.14 * velocity * polyComp, startAt);
      strikeGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.055);
      strike.connect(strikeFilter);
      strikeFilter.connect(strikeGain);
      strikeGain.connect(tone);
      strike.start(startAt);
      strike.stop(startAt + 0.1);
    }
    return true;
  };

  const playMidiFromOffset = async (
    notes: MidiNote[],
    durationSec: number,
    offsetSec: number,
    gen: number
  ) => {
    stopMidiNodes();
    if (audioEngine.playMidi(notes, durationSec, offsetSec)) {
      // The backend owns the playhead and the end of the piece from here.
      // The ticker and end timer below exist only because the Web Audio
      // synth could not report either: it scheduled oscillators and then
      // estimated when they would be done.
      midiOnBackendRef.current = true;
      return;
    }
    const ok = await scheduleMidiNotes(notes, durationSec, offsetSec);
    if (!ok || generationRef.current !== gen) return;

    midiTickerRef.current = window.setInterval(() => {
      const ctx = midiCtxRef.current;
      if (!ctx || ctx.state !== 'running') return;
      const elapsed = Math.max(0, ctx.currentTime - midiStartedAtRef.current);
      setCurrentTime(Math.min(durationSec, offsetSec + elapsed));
    }, 50);

    const remainingMs = Math.max(0, (durationSec - offsetSec) * 1000);
    midiEndTimerRef.current = window.setTimeout(() => {
      if (generationRef.current !== gen) return;
      setCurrentTime(durationSec);
      midiOffsetRef.current = durationSec;
      stopMidiNodes();
      handleTrackEndRef.current();
    }, remainingMs + 40);
  };

  const loadMidiNotes = async (asset: Asset): Promise<MidiNote[]> => {
    const preloaded = (asset.meta as MidiMeta | undefined)?.pianoRoll;
    if (Array.isArray(preloaded) && preloaded.length) return preloaded;
    return assetService.getMidiNotes(asset.id);
  };

  // ─── One-time setup ────────────────────────────────────────────────────

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = 'auto';
    }
    const audio = audioRef.current;

    // Wire engine callbacks → store
    audioEngine.onTimeUpdate = (t) => setCurrentTime(t);
    audioEngine.onDuration = (d) => setDuration(d);
    audioEngine.onEnded = () => handleTrackEndRef.current();

    // A dead context has been replaced. The engine deliberately does not
    // restart anything itself — it has no idea what the user wants — so the
    // decision is made here, from the store, and only for a sample that is
    // still selected, still meant to be playing, and not already coming out
    // of the element.
    audioEngine.onContextRestored = () => {
      const state = usePlayerStore.getState();
      const asset = state.currentAsset;
      if (!asset || asset.type !== 'sample' || !state.isPlaying) return;
      if (fallbackActiveRef.current) return;
      if (audioEngine.isPlayingPath(asset.path)) return;
      // `isPlaying` is not proof that anything is wanted. A stalled context
      // never fires `onended`, so a sample that was mid-play when the user
      // swiped to another desktop stays "playing" the entire time they are
      // away — this is the same stale-intent bug the engine's old
      // `currentPath` replay had, just one layer up. Restart only something
      // asked for in the last couple of seconds; otherwise admit it stopped.
      if (performance.now() - playRequestedAtRef.current > 2000) {
        usePlayerStore.getState().pause();
        return;
      }
      audioEngine
        .playBufferAsync(asset.path, pausedAtRef.current, stillWanted(asset.id, generationRef.current))
        .catch(() => {});
    };

    // A source started and was not heard. The engine is repairing itself;
    // meanwhile the sample the user asked for can still come out of the
    // element, which does not depend on the context at all.
    audioEngine.onStartFailed = (path) => {
      const state = usePlayerStore.getState();
      const asset = state.currentAsset;
      if (!asset || asset.type !== 'sample' || !state.isPlaying) return;
      if (asset.path !== path || fallbackActiveRef.current) return;
      startFallbackRef.current(asset.path, pausedAtRef.current);
    };

    // The engine cannot check this for itself: it knows the path it started,
    // not the sample on screen. If those disagree, the user is hearing one
    // thing and looking at another — the whole of the "it played the bottom
    // one" report — and this is the line in the log that proves it.
    const onEngineStart = (e: Event) => {
      const started = (e as CustomEvent<{ path: string }>).detail?.path;
      if (!started) return;
      // Compared a turn of the event loop later, not now. A row click starts
      // the engine *before* it writes the store — that is the whole point of
      // the synchronous hot path — so comparing immediately flagged every
      // ordinary click as a mismatch. 368 of the ~1,900 lines in the recorded
      // log are this false positive, crowding the 300-event ring that the
      // silence dump is supposed to explain.
      window.setTimeout(() => {
        const shown = usePlayerStore.getState().currentAsset?.path ?? null;
        if (shown && started !== shown) {
          audioEngine.note('start:mismatch', { started, shown });
        }
      }, 0);
    };
    window.addEventListener('audioEnginePlaybackStart', onEngineStart);

    // Fallback HTML audio events
    // The element reaching 'playing' is the moment sound starts on that path,
    // measured against the same request the engine is measured against — so
    // the log can say which route a delayed play took and how long it cost.
    const onFallbackPlaying = () => {
      const path = fallbackSrcRef.current;
      if (!path) return;
      // Last line of defence against both routes sounding at once. `playing`
      // fires earlier than the `play()` promise resolves, so this is the
      // first moment the race can be called — and if the engine already has
      // this sample, the element is a duplicate, not a fallback.
      if (audioEngine.isPlayingPath(path)) {
        audio.pause();
        fallbackActiveRef.current = false;
        fallbackWantRef.current = null;
        return;
      }
      // `playing` can beat the `play()` promise, so this is also where the
      // element's claim on the sample becomes true.
      if (fallbackWantRef.current?.path === path) fallbackActiveRef.current = true;
      if (fallbackActiveRef.current) audioEngine.noteAudible(path, 'element');
    };
    const onFallbackTime = () => {
      if (fallbackActiveRef.current) setCurrentTime(audio.currentTime);
    };
    const onFallbackMeta = () => {
      if (pendingSeekRef.current != null) {
        try {
          audio.currentTime = pendingSeekRef.current;
        } catch {
          /* out of range for this file — start from the top */
        }
        pendingSeekRef.current = null;
      }
      if (fallbackActiveRef.current) setDuration(audio.duration || 0);
    };
    const onFallbackEnd = () => {
      if (fallbackActiveRef.current) {
        fallbackActiveRef.current = false;
        handleTrackEndRef.current();
      }
    };
    audio.addEventListener('playing', onFallbackPlaying);
    audio.addEventListener('timeupdate', onFallbackTime);
    audio.addEventListener('loadedmetadata', onFallbackMeta);
    audio.addEventListener('ended', onFallbackEnd);

    registerSeek((time: number) => {
      const current = usePlayerStore.getState().currentAsset;
      if (current?.type === 'midi') {
        const bounded = Math.max(0, Math.min(midiDurationRef.current || time, time));
        midiOffsetRef.current = bounded;
        setCurrentTime(bounded);
        if (usePlayerStore.getState().isPlaying && midiNotesRef.current.length > 0) {
          const gen = generationRef.current;
          playMidiFromOffset(midiNotesRef.current, midiDurationRef.current, bounded, gen);
        }
        return;
      }
      // Sample seek.
      //
      // Logged because this is the only route to a start that wrote nothing
      // to the ring, and a capture full of unexplained `playAsync:start` is
      // the result: holding an arrow key seeks at the key-repeat rate, each
      // seek stops and restarts the source, and nothing said why.
      audioEngine.note('seek', { path: current?.path ?? null, to: Number(time.toFixed(3)) });
      pausedAtRef.current = time;
      // Whichever path is making the sound is the one to seek. Routing a seek
      // into the engine while the element is playing left the element running
      // from where it was and the engine unable to start.
      if (fallbackActiveRef.current && audioRef.current) {
        audioRef.current.currentTime = time;
      } else if (current) {
        const { isPlaying, play: playFrom } = usePlayerStore.getState();
        if (isPlaying) {
          audioEngine.stop();
          audioEngine
            .playBufferAsync(current.path, time, stillWanted(current.id, generationRef.current))
            .catch(() => {});
        } else {
          // Clicking a waveform is a request to hear from there, and it was
          // only honoured while something was already playing. That was
          // survivable for exactly as long as a finished sample could keep
          // claiming to play: a stalled context never fires `onended`, so
          // `isPlaying` stayed true for minutes and the branch above caught
          // nearly everything. The backend reports the end precisely, so the
          // flag is now false the moment the sample stops and every click on
          // the player bar landed in silence.
          //
          // It is the rule the arrow keys already follow — seeking is an
          // audition — and the start goes through the store so it uses the
          // one path that owns offsets (`pendingStartAt` + `playSeq`) rather
          // than racing it.
          playFrom(current, time);
        }
      }
    });

    return () => {
      window.removeEventListener('audioEnginePlaybackStart', onEngineStart);
      audio.removeEventListener('playing', onFallbackPlaying);
      audio.removeEventListener('timeupdate', onFallbackTime);
      audio.removeEventListener('loadedmetadata', onFallbackMeta);
      audio.removeEventListener('ended', onFallbackEnd);
      audioEngine.onTimeUpdate = null;
      audioEngine.onDuration = null;
      audioEngine.onEnded = null;
      audioEngine.onContextRestored = null;
      if (fallbackUrlRef.current) {
        URL.revokeObjectURL(fallbackUrlRef.current);
        fallbackUrlRef.current = null;
      }
      stopMidiNodes();
      // Close the shared MIDI context on unmount
      if (midiCtxRef.current && midiCtxRef.current.state !== 'closed') {
        midiCtxRef.current.close().catch(() => {});
        midiCtxRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setCurrentTime, setDuration, pause, registerSeek]);

  // ─── Unified playback effect ───────────────────────────────────────────
  //
  // A single effect reacts to BOTH currentAsset and isPlaying changes.
  // This eliminates the race where two separate effects fire in the same
  // React batch and both try to start/stop audio simultaneously.

  useEffect(() => {
    // Bump generation so any in-flight async work from the previous render
    // knows it's been superseded.
    const gen = ++generationRef.current;

    if (!currentAsset) {
      // Nothing selected — stop everything
      audioEngine.stop();
      if (fallbackActiveRef.current) {
        audioRef.current?.pause();
        fallbackActiveRef.current = false;
      }
      stopMidiNodes();
      return;
    }

    // ── Sample ──────────────────────────────────────────────────────────

    if (currentAsset.type === 'sample') {
      // The editor owns the output while it is open.
      //
      // Its transport runs through the same store as the browser's, so
      // pressing play in the editor used to start this effect as well — and
      // the two now share one mixer rather than two Web Audio contexts, so
      // whichever command landed last silenced the other. That is the
      // editor's play button doing nothing: it started the editor's voice
      // and then a `Cmd::Stop` from here cleared it.
      if (useUiStore.getState().editorAssetId) return;

      // Stop MIDI if we're switching to a sample
      stopMidiNodes();
      midiOffsetRef.current = 0;
      midiNotesRef.current = [];
      midiDurationRef.current = 0;

      // Where to start from, and the question is who asked.
      //
      // This used to key off the asset changing, which is not the same thing
      // and was wrong in both directions. A `play(asset, 0)` aimed at the
      // sample already loaded — clicking the filename on a row whose waveform
      // was clicked at 3.2s a moment earlier — changed no asset, so the 0 was
      // dropped and playback resumed at 3.2 (issue #14). And next/previous,
      // which change the asset without making a request at all, inherited
      // whatever offset the last waveform click had left behind.
      //
      // `playSeq` is the request. An asset that changed by any other route
      // starts at the beginning, which is what every one of those routes
      // means. The spacebar is untouched either way: it is `resume()`, a
      // separate action that never comes through here.
      const { pendingStartAt, playSeq } = usePlayerStore.getState();
      const requested = playSeq !== playSeqRef.current;
      const assetChanged = currentAssetIdRef.current !== currentAsset.id;
      playSeqRef.current = playSeq;
      currentAssetIdRef.current = currentAsset.id;
      if (requested) pausedAtRef.current = pendingStartAt;
      else if (assetChanged) pausedAtRef.current = 0;

      const isEdited = editorAssetId === currentAsset.id;

      if (isEdited) {
        // SampleEditor is open for this asset. It takes full control of playback.
        audioEngine.stop();
        if (fallbackActiveRef.current) {
          audioRef.current?.pause();
          fallbackActiveRef.current = false;
        }
        if (currentAsset.durationMs) setDuration(currentAsset.durationMs / 1000);
        return;
      }

      if (!isPlaying) {
        // Stopping or pausing. `stop()` means back to the start; `pause()`
        // means hold the playhead. Treating both as a pause is what made the
        // play button appear to die on short one-shots: every press recorded a
        // later resume point until it reached the end of the file, and only
        // selecting another sample cleared it (issue #12).
        const { stopSeq } = usePlayerStore.getState();
        const wasStopped = stopSeq !== stopSeqRef.current;
        stopSeqRef.current = stopSeq;

        if (audioEngine.isActive()) {
          const at = audioEngine.pause();
          pausedAtRef.current = wasStopped ? 0 : at;
          // Not `else if`: the element can be live at the same time after a
          // fallback play, and leaving it running is audio that no transport
          // control can stop.
          stopFallback();
        } else if (fallbackActiveRef.current && audioRef.current) {
          pausedAtRef.current = wasStopped ? 0 : audioRef.current.currentTime;
          stopFallback();
          // Not only the element. A start can be parked inside the engine
          // waiting for a context; `stop()` is what tells it that whatever it
          // is holding is no longer wanted. Calling it only when the engine
          // was already making sound left those starts live, to be heard
          // minutes later over whatever is selected by then.
          audioEngine.stop();
        } else {
          if (wasStopped) pausedAtRef.current = 0;
          audioEngine.stop();
          // Not playing anything — just prefetch so it's ready when resumed.
          audioEngine.prefetch(currentAsset.path);
          // The element is primed only when the engine is in no state to
          // answer. It used to be primed on every selection, on the reasoning
          // that an unprimed element is the audible lag — true when priming
          // was setting a `src`. It now reads the whole file into a blob, and
          // doing that for every sample the user lands on is a second full
          // read of a file that is already being decoded, for a route that
          // will not be used while the engine is alive.
          if (!audioEngine.isOutputLive()) primeFallback(currentAsset.path);
        }
        return;
      }

      // From here on the user has asked for sound, now. Recorded so a context
      // that comes back much later can tell a live request from a stale one.
      playRequestedAtRef.current = performance.now();

      // Playing — check if the engine is already playing THIS EXACT asset.
      // This happens when the arrow-key / click handler called playBuffer()
      // synchronously before the store update triggered this effect. Don't restart it.
      //
      // Critical: only `isPlayingPath` is safe here. `isActive()` returns true even
      // when the engine is still playing the PREVIOUS asset — if we trust it then,
      // the new asset never starts. That was the "click play → nothing happens
      // until you hit Stop first" bug.
      if (audioEngine.isPlayingPath(currentAsset.path)) {
        stopFallback();
        if (currentAsset.durationMs) {
          setDuration(currentAsset.durationMs / 1000);
        }
        assetService.incrementPlayCount(currentAsset.id).catch(() => {});
        return;
      }

      // Engine is idle, or playing a stale source from the previous asset.
      // Stop the stale source explicitly so playBuffer below starts cleanly
      // and so any subsequent isActive() checks reflect reality.
      if (audioEngine.isActive()) {
        audioEngine.stop();
      }

      // Reset pause position when switching to a new asset
      // (pausedAtRef is 0 for a fresh play, non-zero for resume)
      const offset = pausedAtRef.current;
      // Try instant buffer playback first
      const started = audioEngine.playBuffer(currentAsset.path, offset);
      if (started) {
        stopFallback();
        assetService.incrementPlayCount(currentAsset.id).catch(() => {});
        return;
      }

      // The engine could not take it. Clear any stale element state before
      // deciding where this one goes.
      stopFallback();

      // The buffer is in memory and only the context is missing. Both routes
      // to sound are imperfect here, so race them rather than choosing:
      //
      //  - Waiting for the engine can take most of a second after a desktop
      //    switch — a bounded resume, a rebuild, another resume and a clock
      //    probe all have to finish first.
      //  - Going straight to the element gives that up even when the context
      //    would have woken in a few milliseconds, which it usually does,
      //    because this runs inside the user's own gesture and that is the
      //    one moment WebKit reliably grants a resume.
      //
      // So the engine gets a short head start and the element is loaded (not
      // played) alongside it. If the engine has not made a sound by the time
      // the grace runs out, the element plays, instantly, because it is
      // already loaded. Whichever starts first wins outright: `wanted` goes
      // false once the element is live, so a late engine start is abandoned
      // rather than played on top.
      if (audioEngine.hasBuffer(currentAsset.path)) {
        const assetId = currentAsset.id;
        const path = currentAsset.path;
        const wanted = () => stillWanted(assetId, gen)() && !fallbackActiveRef.current;
        const live = audioEngine.isOutputLive();
        if (!live) primeFallback(path);

        const grace = window.setTimeout(() => {
          if (wanted()) startFallbackRef.current(path, offset);
        }, live ? ENGINE_GRACE_MS * 2 : ENGINE_GRACE_MS);

        audioEngine
          .playBufferAsync(path, offset, wanted)
          .then((ok) => {
            window.clearTimeout(grace);
            if (!ok && wanted()) startFallbackRef.current(path, offset);
          })
          .catch(() => {
            window.clearTimeout(grace);
            if (wanted()) startFallbackRef.current(path, offset);
          });
        assetService.incrementPlayCount(currentAsset.id).catch(() => {});
        return;
      }

      // Use HTML audio as fallback while decoding in background. `primeFallback`
      // is usually a no-op here because selecting the asset already loaded it;
      // that is the difference between this path being a seamless stand-in and
      // being an audible delay.
      startFallback(currentAsset.path, offset);

      // Decode in background — seamlessly switch to buffer when ready
      const assetId = currentAsset.id;
      const assetPath = currentAsset.path;
      audioEngine.ensureBuffer(assetPath).then((buffer) => {
        // Bail if the asset or play state changed while we were decoding
        if (generationRef.current !== gen) return;
        if (!buffer) return;
        const state = usePlayerStore.getState();
        if (state.currentAsset?.id !== assetId || !state.isPlaying) return;

        // Deliberately NOT gated on the element being live.
        //
        // Usually it is, and this is a seamless handover. But when its
        // `play()` was refused — which is what the first click after a cold
        // launch looks like, the element having been given a source and a
        // play in the same tick — nothing is making any sound at all, and
        // this freshly decoded buffer is the only thing that can. Bailing out
        // here is why the first sample was silent and the second was fine:
        // the one path that could have rescued it checked whether the path
        // that had already failed was running.
        const wasLive = fallbackActiveRef.current;
        // Hand over ONLY if the engine actually took it. `playBuffer` returns
        // false whenever the AudioContext is not running — exactly what happens
        // after the app has been in the background — and pausing the element
        // first turned that into silence while the UI still read "playing".
        // The element keeps the sound until there is something to hand it to.
        const resumeAt = wasLive ? (audioRef.current?.currentTime ?? 0) : offset;
        if (audioEngine.playBuffer(assetPath, resumeAt)) {
          // Unconditionally, not `if (wasLive)`. This decode and the element's
          // own blob fetch read the same file over the same protocol and land
          // within milliseconds of each other, so the usual loser is an
          // element whose `play()` is in flight but has not reached `playing`
          // yet — invisible to `wasLive`, and the second copy of the sample
          // you then hear.
          stopFallback();
        } else if (!wasLive) {
          // Neither route has made a sound. The element is at least loaded by
          // now, which is the condition its first attempt did not have.
          startFallbackRef.current(assetPath, offset);
        }
      });

      assetService.incrementPlayCount(currentAsset.id).catch(() => {});
      return;
    }

    // ── Non-sample: stop sample engine ──────────────────────────────────
    audioEngine.stop();
    if (fallbackActiveRef.current) {
      audioRef.current?.pause();
      fallbackActiveRef.current = false;
    }
    // Reset sample pause position and asset tracking when switching away
    pausedAtRef.current = 0;
    currentAssetIdRef.current = null;

    if (currentAsset.type !== 'midi') {
      stopMidiNodes();
      return;
    }

    // ── MIDI ─────────────────────────────────────────────────────────────

    // Reset offset when switching to a different MIDI asset
    if (midiAssetIdRef.current !== currentAsset.id) {
      midiAssetIdRef.current = currentAsset.id;
      midiOffsetRef.current = 0;
    }

    if (!isPlaying) {
      pauseMidi();
      return;
    }

    // Load notes (may be instant from meta, or an IPC round-trip)
    const capturedAsset = currentAsset;
    (async () => {
      const notes = await loadMidiNotes(capturedAsset).catch(() => [] as MidiNote[]);
      if (generationRef.current !== gen) return; // superseded
      midiNotesRef.current = notes;
      const durationSec = getMidiDurationSeconds(notes, capturedAsset.durationMs);
      midiDurationRef.current = durationSec;
      setDuration(durationSec);
      if (!usePlayerStore.getState().isPlaying) {
        pauseMidi();
        return;
      }
      await playMidiFromOffset(notes, durationSec, midiOffsetRef.current, gen);
      if (generationRef.current === gen) {
        assetService.incrementPlayCount(capturedAsset.id).catch(() => {});
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentAsset, isPlaying, editorAssetId]);
}
