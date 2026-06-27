import { create } from 'zustand';

export interface Cue {
  id: string;
  position: number; // seconds
  label?: string;
}

export type WaveStyle = 'filled' | 'line';

/**
 * Editor waveform color choices. The 'accent' sentinel follows the live app
 * accent (resolved at draw time from the theme) so the editor matches whatever
 * theme the user picked; the rest are fixed hexes for those who want a specific
 * color regardless of theme.
 */
export const ACCENT_WAVE_COLOR = 'accent';

export const WAVE_COLORS = [
  { name: 'Accent', hex: ACCENT_WAVE_COLOR },
  { name: 'Amber',  hex: '#F5B841' },
  { name: 'Mint',   hex: '#5FD4A0' },
  { name: 'Cyan',   hex: '#4FC3F7' },
  { name: 'Violet', hex: '#B58CF0' },
  { name: 'White',  hex: '#E8E8E8' },
] as const;

interface EditorStore {
  zoom: number;
  scroll: number;
  cues: Cue[];
  waveColor: string;
  waveStyle: WaveStyle;
  showBeatGrid: boolean;
  setZoom: (z: number) => void;
  setScroll: (s: number) => void;
  resetView: () => void;
  addCue: (position: number) => void;
  removeCue: (id: string) => void;
  clearCues: () => void;
  setWaveColor: (c: string) => void;
  setWaveStyle: (s: WaveStyle) => void;
  setShowBeatGrid: (v: boolean) => void;
  reset: () => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 64;

const COLOR_KEY = 'stack:editor:waveColor';
const STYLE_KEY = 'stack:editor:waveStyle';
const GRID_KEY = 'stack:editor:showBeatGrid';

// The legacy "Fire" default (#F2613F) predates the theme-following 'accent'
// swatch. Migrate it so existing users' editor waveform tracks their chosen
// accent instead of staying frozen on the old orange.
const LEGACY_FIRE = '#f2613f';

function loadColor(): string {
  try {
    const v = localStorage.getItem(COLOR_KEY);
    if (v && v.toLowerCase() === LEGACY_FIRE) return ACCENT_WAVE_COLOR;
    if (v === ACCENT_WAVE_COLOR || (v && /^#[0-9a-f]{3,8}$/i.test(v))) return v;
  } catch { /* noop */ }
  return ACCENT_WAVE_COLOR;
}
function loadStyle(): WaveStyle {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    if (v === 'line' || v === 'filled') return v;
  } catch { /* noop */ }
  return 'filled';
}
function loadShowGrid(): boolean {
  try {
    const v = localStorage.getItem(GRID_KEY);
    if (v !== null) return v === 'true';
  } catch { /* noop */ }
  return true;
}

export const useEditorStore = create<EditorStore>((set) => ({
  zoom: 1,
  scroll: 0,
  cues: [],
  waveColor: loadColor(),
  waveStyle: loadStyle(),
  showBeatGrid: loadShowGrid(),
  setZoom: (z) => set(() => ({ zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)) })),
  setScroll: (s) => set(() => ({ scroll: Math.max(0, Math.min(1, s)) })),
  resetView: () => set({ zoom: 1, scroll: 0 }),
  addCue: (position) =>
    set((s) => ({
      cues: [...s.cues, { id: `cue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, position }]
        .sort((a, b) => a.position - b.position),
    })),
  removeCue: (id) => set((s) => ({ cues: s.cues.filter((c) => c.id !== id) })),
  clearCues: () => set({ cues: [] }),
  setWaveColor: (c) => {
    try { localStorage.setItem(COLOR_KEY, c); } catch { /* noop */ }
    set({ waveColor: c });
  },
  setWaveStyle: (st) => {
    try { localStorage.setItem(STYLE_KEY, st); } catch { /* noop */ }
    set({ waveStyle: st });
  },
  setShowBeatGrid: (v) => {
    try { localStorage.setItem(GRID_KEY, String(v)); } catch { /* noop */ }
    set({ showBeatGrid: v });
  },
  reset: () => set({ zoom: 1, scroll: 0, cues: [] }),
}));

export { MIN_ZOOM, MAX_ZOOM };
