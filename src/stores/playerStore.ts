import { create } from 'zustand';
import type { Asset } from '../types';

interface PlayerStore {
  currentAsset: Asset | null;
  /** The current page's asset list — kept in sync by AssetGrid */
  playlist: Asset[];
  isPlaying: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  bpmSync: number | null;
  /** Seconds to start from on the next asset switch — set by play(asset, startAt). */
  pendingStartAt: number;

  play: (asset: Asset, startAt?: number) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  playNext: () => void;
  playPrev: () => void;
  setVolume: (volume: number) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setBpmSync: (bpm: number | null) => void;
  setPlaylist: (assets: Asset[]) => void;
  /** Drop the playing sample entirely — for when it no longer exists on disk. */
  clearCurrent: () => void;
  /** Seek function — wired up by usePlayer hook */
  seekTo: ((time: number) => void) | null;
  registerSeek: (fn: (time: number) => void) => void;
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  currentAsset: null,
  playlist: [],
  isPlaying: false,
  volume: 0.9,
  currentTime: 0,
  duration: 0,
  bpmSync: null,
  pendingStartAt: 0,
  seekTo: null,

  play: (asset, startAt = 0) =>
    set({
      currentAsset: asset,
      isPlaying: true,
      currentTime: startAt,
      duration: 0,
      pendingStartAt: startAt,
    }),
  pause: () => set({ isPlaying: false }),
  resume: () => set({ isPlaying: true }),
  stop: () => set({ isPlaying: false, currentTime: 0 }),

  playNext: () => {
    const { currentAsset, playlist } = get();
    if (!playlist.length) return;
    const idx = currentAsset ? playlist.findIndex((a) => a.id === currentAsset.id) : -1;
    const next = playlist[idx + 1];
    if (next) set({ currentAsset: next, isPlaying: true, currentTime: 0, duration: 0 });
  },

  playPrev: () => {
    const { currentAsset, playlist, currentTime, seekTo } = get();
    if (!playlist.length) return;
    // If more than 3 seconds in, restart current track instead of going back
    if (currentTime > 3 && seekTo) {
      seekTo(0);
      return;
    }
    const idx = currentAsset ? playlist.findIndex((a) => a.id === currentAsset.id) : 1;
    const prev = playlist[idx - 1];
    if (prev) set({ currentAsset: prev, isPlaying: true, currentTime: 0, duration: 0 });
  },

  setVolume: (volume) => set({ volume }),
  setCurrentTime: (currentTime) => set({ currentTime }),
  setDuration: (duration) => set({ duration }),
  setBpmSync: (bpmSync) => set({ bpmSync }),
  /**
   * The playlist is only what prev/next walk through. It deliberately does
   * NOT own the playing sample: searching, opening another pack or switching
   * tabs all swap this list, and clearing playback because the sample left
   * the current view made it impossible to audition something while browsing
   * for the next one. A sample that is genuinely gone from disk is caught by
   * the asset-exists check that runs on library events.
   */
  setPlaylist: (playlist) => set({ playlist }),

  clearCurrent: () =>
    set({ currentAsset: null, isPlaying: false, currentTime: 0, duration: 0 }),
  registerSeek: (fn) => set({ seekTo: fn }),
}));
