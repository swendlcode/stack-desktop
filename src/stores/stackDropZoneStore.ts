import { create } from 'zustand';
import type { Asset } from '../types';

export interface Zone {
  /** `null` means "Favorites itself" — favourite the asset without filing it. */
  stackId: string | null;
  el: HTMLElement;
}

/**
 * Registry of on-screen favourites drop targets plus whichever assets are
 * mid-drag. The same stack can be shown in more than one place at once (the
 * Favorites strip AND the sidebar), so zones are keyed by a unique
 * registration key, not by stack id.
 *
 * Hit-testing is a plain rect containment check in viewport (CSS px) space,
 * which is what `getBoundingClientRect()` returns — callers convert from
 * whatever space their event reports first.
 */
interface StackDropZoneState {
  zones: Map<string, Zone>;
  registerZone: (key: string, stackId: string | null, el: HTMLElement) => void;
  unregisterZone: (key: string) => void;
  /** The zone under a viewport point, or null. */
  hitTest: (viewportX: number, viewportY: number) => Zone | null;
  draggingAssets: Asset[];
  setDraggingAssets: (assets: Asset[]) => void;
  /**
   * Set by `useStackDropListener`, which owns the query client. Called with
   * the zone a drag landed on so the drop can be applied from outside React.
   */
  dropHandler: ((zone: Zone, assets: Asset[]) => void) | null;
  setDropHandler: (fn: ((zone: Zone, assets: Asset[]) => void) | null) => void;
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
  hitTest: (viewportX, viewportY) => {
    for (const zone of get().zones.values()) {
      const rect = zone.el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (
        viewportX >= rect.left &&
        viewportX <= rect.right &&
        viewportY >= rect.top &&
        viewportY <= rect.bottom
      ) {
        return zone;
      }
    }
    return null;
  },
  draggingAssets: [],
  setDraggingAssets: (assets) => set({ draggingAssets: assets }),
  dropHandler: null,
  setDropHandler: (fn) => set({ dropHandler: fn }),
}));
