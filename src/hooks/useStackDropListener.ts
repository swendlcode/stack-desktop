import { useEffect } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { isTauri } from '../lib/tauri-core';
import { useQueryClient } from '@tanstack/react-query';
import { stackService } from '../services/stackService';
import { assetService } from '../services/assetService';
import { assetQueryKeys } from './useAssets';
import { stackQueryKeys } from './useStacks';
import { useStackDropZoneStore, type Zone } from '../stores/stackDropZoneStore';
import type { Asset } from '../types';

/**
 * Applies a drop onto a favourites target, and keeps a second path open for
 * file drags that come from outside the app.
 *
 * Our row drag is a native OS drag-out, so the DOM's own drag events never
 * fire. The drop used to be read from Tauri's window-level `onDragDropEvent`,
 * but that reports drags entering the window from elsewhere — a drag the app
 * itself started and dropped on its own window is not delivered there, so
 * nothing ever landed. The drag plugin's own completion callback is the
 * reliable signal; see `dragService.startFileDrag`. This hook just owns the
 * query client and hands the store a handler it can call.
 */
export function useStackDropListener() {
  const queryClient = useQueryClient();

  // The handler the native drag callback reaches for.
  useEffect(() => {
    const apply = (zone: Zone, assets: Asset[]) => {
      if (assets.length === 0) return;
      const ids = assets.map((a) => a.id);
      // Dropping into a favourites folder implies favouriting; dropping onto
      // Favorites itself only favourites.
      const work: Promise<unknown>[] = [assetService.bulkSetFavorite(ids, true)];
      if (zone.stackId) {
        work.push(...assets.map((a) => stackService.addAssetToStack(zone.stackId as string, a.id)));
      }
      Promise.all(work)
        .then(() => {
          queryClient.invalidateQueries({ queryKey: stackQueryKeys.all });
          queryClient.invalidateQueries({ queryKey: assetQueryKeys.all });
        })
        .catch((err) => console.error('favourites drop failed', err));
    };

    useStackDropZoneStore.getState().setDropHandler(apply);
    return () => useStackDropZoneStore.getState().setDropHandler(null);
  }, [queryClient]);

  // Kept for drags that genuinely originate outside the window, which do
  // arrive here. Harmless when the plugin callback already handled the drop:
  // `draggingAssets` is cleared by whichever path runs first.
  useEffect(() => {
    // Browser mode has no Tauri webview: getCurrentWebview() dereferences
    // window.__TAURI_INTERNALS__.metadata and throws during the effect flush,
    // which took the whole page down when opening Stack over the network.
    if (!isTauri) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return;
        const store = useStackDropZoneStore.getState();
        const assets = store.draggingAssets;
        if (assets.length === 0) return;

        // Position is window-relative in physical px; getBoundingClientRect is
        // in logical (CSS) px, so scale down by the device pixel ratio.
        const scale = window.devicePixelRatio || 1;
        const zone = store.hitTest(
          event.payload.position.x / scale,
          event.payload.position.y / scale,
        );
        if (zone) store.dropHandler?.(zone, assets);
        store.setDraggingAssets([]);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
