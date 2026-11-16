import { useEffect, useRef } from 'react';
import { editorEngine } from '../../services/editorEngine';

/**
 * Stereo peak meter, read post-gain off the editor's own output chain.
 *
 * Two things make a meter feel right, and both are ballistics rather than
 * measurement: it must jump to a peak instantly and fall away slowly, and it
 * must hold the highest recent peak long enough to be read. A bar that tracks
 * the signal symmetrically just flickers.
 *
 * Nothing here goes through React state. The loop writes `transform` on two
 * refs per channel, which the compositor handles without a paint, so a meter
 * running at 60fps costs the rest of the editor nothing. State would re-render
 * the whole control bar sixty times a second.
 */

// Range of the scale. -60dB is the noise floor for a meter this size; +6
// leaves headroom above 0 so clipping is visible rather than just pinned.
const MIN_DB = -60;
const MAX_DB = 6;
// Fraction of the remaining distance the bar falls each frame. At 60fps this
// is roughly 20dB/second, which is close to a hardware VU's return.
const DECAY = 0.12;
// How long the peak marker sits before it starts falling too.
const HOLD_MS = 900;
const HOLD_DECAY = 0.04;
// Above this, the clip dot lights.
const CLIP_DB = -0.1;
const CLIP_HOLD_MS = 1200;

function dbToFraction(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
}

function levelToFraction(linear: number): number {
  if (linear <= 0) return 0;
  return dbToFraction(20 * Math.log10(linear));
}

type ChannelRefs = {
  mask: HTMLDivElement | null;
  hold: HTMLDivElement | null;
};

export function LevelMeter() {
  const left = useRef<ChannelRefs>({ mask: null, hold: null });
  const right = useRef<ChannelRefs>({ mask: null, hold: null });
  const clipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const state = [
      { level: 0, hold: 0, holdUntil: 0 },
      { level: 0, hold: 0, holdUntil: 0 },
    ];
    let clipUntil = 0;
    let clipLit = false;
    let idle = true;

    const apply = (refs: ChannelRefs, level: number, hold: number) => {
      // The mask covers the unlit part from the top, so it scales down as the
      // level rises. Scaling a flat colour shows no distortion, and transform
      // keeps the whole thing off the layout path.
      if (refs.mask) refs.mask.style.transform = `scaleY(${1 - level})`;
      if (refs.hold) {
        refs.hold.style.transform = `translateY(${-hold * 100}%)`;
        refs.hold.style.opacity = hold > 0.001 ? '1' : '0';
      }
    };

    const frame = (now: number) => {
      // Stop once playback has ended AND the bars have fallen to rest, rather
      // than the moment it ends — otherwise the meter freezes mid-bounce. A
      // stopped loop costs nothing; `wake` restarts it on the next play.
      const settled =
        !editorEngine.playing &&
        state.every((s) => s.level < 0.001 && s.hold < 0.001) &&
        now > clipUntil;
      if (settled) {
        idle = true;
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(frame);
      const levels = editorEngine.readLevels();
      const targets = levels
        ? [levelToFraction(levels.left), levelToFraction(levels.right)]
        : [0, 0];

      for (let i = 0; i < 2; i++) {
        const s = state[i];
        const target = targets[i];
        // Instant attack, eased release.
        s.level = target > s.level ? target : s.level + (target - s.level) * DECAY;
        if (s.level >= s.hold) {
          s.hold = s.level;
          s.holdUntil = now + HOLD_MS;
        } else if (now > s.holdUntil) {
          s.hold += (s.level - s.hold) * HOLD_DECAY;
        }
        apply(i === 0 ? left.current : right.current, s.level, s.hold);
      }

      const clipping =
        !!levels && Math.max(levels.left, levels.right) >= Math.pow(10, CLIP_DB / 20);
      if (clipping) clipUntil = now + CLIP_HOLD_MS;
      const lit = now < clipUntil;
      if (lit !== clipLit && clipRef.current) {
        clipLit = lit;
        clipRef.current.style.opacity = lit ? '1' : '0.18';
      }
    };

    const wake = () => {
      if (!idle) return;
      idle = false;
      raf = requestAnimationFrame(frame);
    };

    wake();
    const unsubscribe = editorEngine.subscribe(() => {
      if (editorEngine.playing) wake();
    });

    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const bar = (refs: React.MutableRefObject<ChannelRefs>, label: string) => (
    <div
      className="relative h-9 w-[5px] overflow-hidden rounded-[2px] bg-gray-800"
      aria-label={`${label} level`}
    >
      {/* The lit scale. Green to about -12dB, amber through -3, red at 0. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(to top, #22c55e 0%, #22c55e 58%, #a3e635 70%, #facc15 80%, #f97316 88%, #ef4444 92%, #ef4444 100%)',
        }}
      />
      {/* Covers whatever is not lit, scaled from the top. */}
      <div
        ref={(el) => {
          refs.current.mask = el;
        }}
        className="absolute inset-0 origin-top bg-gray-800"
        style={{ transform: 'scaleY(1)' }}
      />
      {/* Peak hold. Sits at the bottom and is pushed up by translateY. */}
      <div
        ref={(el) => {
          refs.current.hold = el;
        }}
        className="absolute bottom-0 left-0 h-[1.5px] w-full bg-stack-white"
        style={{ transform: 'translateY(0%)', opacity: 0 }}
      />
    </div>
  );

  return (
    <div className="flex shrink-0 items-end gap-1" title="Output level — post gain">
      <div className="flex items-end gap-[3px]">
        {bar(left, 'Left')}
        {bar(right, 'Right')}
      </div>
      <div
        ref={clipRef}
        className="mb-[2px] h-1 w-1 rounded-full bg-red-500"
        style={{ opacity: 0.18 }}
        aria-label="Clip indicator"
      />
    </div>
  );
}
