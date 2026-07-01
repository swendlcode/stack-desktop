import { useEffect } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useQueryClient } from '@tanstack/react-query';
import { stackService } from '../services/stackService';
import { assetService } from '../services/assetService';
import { assetQueryKeys } from './useAssets';
import { stackQueryKeys } from './useStacks';
import { useStackDropZoneStore } from '../stores/stackDropZoneStore';

/**
 * Global listener for dropping a dragged asset onto a favorites folder — a
 * folder card in the Favorites strip OR a folder row in the sidebar. Mounted
 * once at the app root so it works from any page (Browser, MIDI, Presets…),
 * not just Favorites.
 *
 * Uses Tauri's window-level drag-drop event, since our row drag is a native
 * OS drag-out (see dragService/AssetRow) that replaces the DOM's HTML5 DnD.
 * Adding an asset to a folder also marks it as a favorite — dropping into a
 * favorites folder implies favoriting it.
 */
export function useStackDropListener() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return;

        const store = useStackDropZoneStore.getState();
        const { draggingAssets, hitTest } = store;
        // Only act on drops from our own row drag (set by AssetRow on drag
        // start, cleared here on drop) — never external files.
        if (draggingAssets.length === 0) return;

        // Position is window-relative in physical px; getBoundingClientRect is
        // in logical (CSS) px, so scale down by the device pixel ratio.
        const scale = window.devicePixelRatio || 1;
        const stackId = hitTest(event.payload.position.x / scale, event.payload.position.y / scale);

        if (stackId) {
          const ids = draggingAssets.map((a) => a.id);
          Promise.all([
            ...draggingAssets.map((a) => stackService.addAssetToStack(stackId, a.id)),
            assetService.bulkSetFavorite(ids, true),
          ])
            .then(() => {
              queryClient.invalidateQueries({ queryKey: stackQueryKeys.all });
              queryClient.invalidateQueries({ queryKey: assetQueryKeys.all });
            })
            .catch(() => {});
        }
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
  }, [queryClient]);
}
