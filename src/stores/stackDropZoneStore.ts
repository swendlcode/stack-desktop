import { create } from 'zustand';
import type { Asset } from '../types';

interface Zone {
  stackId: string;
  el: HTMLElement;
}

/**
 * Registry of on-screen folder drop targets plus whichever assets are
 * mid-drag. The same stack can be shown in more than one place at once (the
 * Favorites strip AND the sidebar), so zones are keyed by a unique
 * registration key, not by stack id. Tauri's window-level `onDragDropEvent`
 * (see useStackDropListener) reports the drop position in the same viewport
 * coordinate space as `getBoundingClientRect()`, so hit-testing is a plain
 * rect containment check.
 */
interface StackDropZoneState {
  zones: Map<string, Zone>;
  registerZone: (key: string, stackId: string, el: HTMLElement) => void;
  unregisterZone: (key: string) => void;
  hitTest: (logicalX: number, logicalY: number) => string | null;
  draggingAssets: Asset[];
  setDraggingAssets: (assets: Asset[]) => void;
}

export const useStackDropZoneStore = create<StackDropZoneState>((set, get) => ({
  zones: new Map(),
  registerZone: (key, stackId, el) => {
    const next = new Map(get().zones);
    next.set(key, { stackId, el });
    set({ zones: next });
  },
  unregisterZone: (key) => {
    const next = new Map(get().zones);
    next.delete(key);
    set({ zones: next });
  },
  hitTest: (logicalX, logicalY) => {
    for (const { stackId, el } of get().zones.values()) {
      const rect = el.getBoundingClientRect();
      if (
        logicalX >= rect.left &&
        logicalX <= rect.right &&
        logicalY >= rect.top &&
        logicalY <= rect.bottom
      ) {
        return stackId;
      }
    }
    return null;
  },
  draggingAssets: [],
  setDraggingAssets: (assets) => set({ draggingAssets: assets }),
}));
