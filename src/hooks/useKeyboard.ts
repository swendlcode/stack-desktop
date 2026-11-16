import { useEffect } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { useUiStore } from '../stores/uiStore';
import { zoomIn, zoomOut, zoomReset } from '../utils/appZoom';

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
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      const { currentAsset, isPlaying, pause, resume } = usePlayerStore.getState();

      if (e.code === 'Space' && currentAsset) {
        e.preventDefault();
        if (isPlaying) pause();
        else resume();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editorAssetId]);
}
