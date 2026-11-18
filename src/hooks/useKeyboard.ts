import { useEffect } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { useUiStore } from '../stores/uiStore';
import { zoomIn, zoomOut, zoomReset } from '../utils/appZoom';

// The smallest a skip is allowed to be. Short enough not to overshoot a
// one-shot, long enough to be audible on one.
const MIN_SEEK_STEP = 0.2;

export function useKeyboard() {
  const editorAssetId = useUiStore((s) => s.editorAssetId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Zoom is handled before every other guard on purpose: it has to work
      // while the editor is open and while a search field has focus, the same
      // way it does in a browser.
      if (e.metaKey || e.ctrlKey) {
        // `=` is the unshifted key that carries `+`; `code` covers the numpad
        // and keeps the shortcut working on layouts that put `+` elsewhere.
        const zoomIn_ = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
        const zoomOut_ = e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract';
        const zoomReset_ = e.key === '0' || e.code === 'Numpad0';
        if (zoomIn_ || zoomOut_ || zoomReset_) {
          e.preventDefault();
          if (zoomIn_) zoomIn();
          else if (zoomOut_) zoomOut();
          else zoomReset();
          return;
        }
      }

      // While sample editor is open, keyboard transport is owned by editor logic.
      if (editorAssetId) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          // Volume and the other sliders answer to the arrow keys themselves.
          target.closest('[role="slider"]') !== null)
      ) {
        return;
      }

      const { currentAsset, isPlaying, pause, resume } = usePlayerStore.getState();

      if (e.code === 'Space' && currentAsset) {
        e.preventDefault();
        if (isPlaying) pause();
        else resume();
        return;
      }

      // Left/right skip through the sample being auditioned. The step is a
      // share of the length rather than a number of seconds, so one press
      // means the same thing on a one-second one-shot and on a thirty-second
      // loop; hold shift for a bigger jump. Up/down belong to the list and
      // are handled there.
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && currentAsset) {
        const { duration, currentTime, seekTo, setCurrentTime } = usePlayerStore.getState();
        if (!seekTo || duration <= 0) return;
        e.preventDefault();
        // A floor under the step, because a share of a short sample is not a
        // step at all: a tenth of a 400ms clap is 40ms, which moves the
        // playhead by less than the attack and sounds exactly like nothing
        // happened. On anything long the share is far bigger than the floor
        // and this changes nothing.
        const step = Math.max(duration * (e.shiftKey ? 0.25 : 0.1), MIN_SEEK_STEP);
        const to = Math.min(
          Math.max(0, currentTime + (e.key === 'ArrowRight' ? step : -step)),
          // Landing exactly on the end is silence, and the sample would read
          // as finished rather than parked at its last moment.
          Math.max(0, duration - 0.02),
        );
        seekTo(to);
        // A seek on a paused sample only moves the engine's resume point, so
        // the playhead has to be moved here or a second press would compute
        // its step from the same stale position and go nowhere.
        setCurrentTime(to);
        // And it only moves that point — nothing is heard. On a one-shot
        // that is the normal case rather than an edge one: the sample has
        // already finished by the time the hand reaches the arrow key, so
        // every press scrubbed silently. Skipping is an audition, so it
        // plays from where it lands.
        if (!isPlaying) resume();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editorAssetId]);
}
