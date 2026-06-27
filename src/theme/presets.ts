/**
 * Curated theme presets. Each pairs a base mode (dark/light — drives the neutral
 * grey ramp + bg/fg via `data-theme`) with an accent hex. Picking a preset writes
 * both `theme` and `accentColor` to settings; the active preset is derived by
 * matching the current pair, so no preset id is persisted.
 */

export type ThemeBase = 'dark' | 'light';

export interface ThemePreset {
  id: string;
  label: string;
  base: ThemeBase;
  accent: string;
}

/** The built-in default accent (matches --stack-fire in src/index.css). */
export const DEFAULT_ACCENT = '#F2613F';

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'ember', label: 'Ember', base: 'dark', accent: DEFAULT_ACCENT },
  { id: 'ocean', label: 'Ocean', base: 'dark', accent: '#3FA0F2' },
  { id: 'forest', label: 'Forest', base: 'dark', accent: '#3FBF6A' },
  { id: 'grape', label: 'Grape', base: 'dark', accent: '#A06CF2' },
  { id: 'rose', label: 'Rose', base: 'dark', accent: '#F23F8C' },
  { id: 'gold', label: 'Gold', base: 'dark', accent: '#E0B23F' },
  { id: 'mono', label: 'Mono', base: 'dark', accent: '#CFCFCF' },
  { id: 'daylight', label: 'Daylight', base: 'light', accent: '#E85A3A' },
  { id: 'paper', label: 'Paper', base: 'light', accent: '#3F7AF2' },
];

/** Quick-pick accent swatches shown in the picker (preset accents + a couple extras). */
export const ACCENT_SWATCHES: string[] = [
  DEFAULT_ACCENT,
  '#3FA0F2',
  '#3FBF6A',
  '#A06CF2',
  '#F23F8C',
  '#E0B23F',
  '#2DD4BF',
  '#CFCFCF',
];

/** Case-insensitive hex comparison (ignores leading #). */
export function sameHex(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (h: string | null | undefined) => (h ?? '').trim().replace(/^#/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** Find the preset matching the current (base, accent) pair, if any. */
export function matchPreset(base: ThemeBase, accent: string | null | undefined): ThemePreset | undefined {
  const effective = accent ?? DEFAULT_ACCENT;
  return THEME_PRESETS.find((p) => p.base === base && sameHex(p.accent, effective));
}
