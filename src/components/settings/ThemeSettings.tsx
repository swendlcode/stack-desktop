import { applyTheme } from '../../hooks/useTheme';
import {
  THEME_PRESETS,
  ACCENT_SWATCHES,
  DEFAULT_ACCENT,
  matchPreset,
  sameHex,
  type ThemeBase,
  type ThemePreset,
} from '../../theme/presets';
import type { Settings } from '../../types';

/** Representative bg/surface/text per base — used only for the preset previews. */
const BASE_SWATCH: Record<ThemeBase, { bg: string; surface: string; text: string }> = {
  dark: { bg: '#0c0c0c', surface: '#242424', text: '#f7f7f7' },
  light: { bg: '#ffffff', surface: '#e6e6e6', text: '#1a1a1a' },
};

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

/**
 * Theme picker: base mode (drives the neutral ramp via data-theme) + accent.
 * Every action applies optimistically through applyTheme so the whole app
 * recolors instantly, then persists via onChange (SettingsPage.updateAndSave).
 */
export function ThemeSettings({ settings, onChange }: Props) {
  const base: ThemeBase = settings.theme === 'light' ? 'light' : 'dark';
  const accent = settings.accentColor ?? DEFAULT_ACCENT;
  const activePreset = matchPreset(base, accent);

  const selectBase = (next: ThemeBase) => {
    applyTheme(next, settings.accentColor);
    onChange({ theme: next });
  };

  const selectPreset = (p: ThemePreset) => {
    applyTheme(p.base, p.accent);
    onChange({ theme: p.base, accentColor: p.accent });
  };

  const selectAccent = (hex: string) => {
    applyTheme(base, hex);
    onChange({ accentColor: hex });
  };

  return (
    <div className="space-y-6 px-3 py-2">
      {/* Base mode */}
      <div>
        <p className="mb-2 text-xs uppercase tracking-wider text-gray-500">Base</p>
        <div className="inline-flex rounded-lg border border-gray-700 bg-gray-800 p-0.5">
          {(['dark', 'light'] as ThemeBase[]).map((b) => (
            <button
              key={b}
              onClick={() => selectBase(b)}
              className={`rounded-md px-4 py-1.5 text-xs capitalize transition-colors ${
                base === b ? 'bg-stack-fire text-white' : 'text-gray-400 hover:text-stack-white'
              }`}
            >
              {b}
            </button>
          ))}
        </div>
      </div>

      {/* Preset cards */}
      <div>
        <p className="mb-2 text-xs uppercase tracking-wider text-gray-500">Presets</p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {THEME_PRESETS.map((p) => {
            const sw = BASE_SWATCH[p.base];
            const active = activePreset?.id === p.id;
            return (
              <button
                key={p.id}
                onClick={() => selectPreset(p)}
                className={`group flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors ${
                  active
                    ? 'border-stack-fire bg-stack-fire/10'
                    : 'border-gray-700 hover:border-gray-600'
                }`}
              >
                <div
                  className="relative h-12 w-full overflow-hidden rounded-md border border-black/20"
                  style={{ background: sw.bg }}
                >
                  <div
                    className="absolute left-1.5 top-1.5 h-1.5 w-8 rounded-full"
                    style={{ background: sw.surface }}
                  />
                  <div
                    className="absolute bottom-1.5 left-1.5 h-1.5 w-5 rounded-full"
                    style={{ background: sw.text, opacity: 0.7 }}
                  />
                  <div
                    className="absolute bottom-1.5 right-1.5 h-3.5 w-3.5 rounded-full"
                    style={{ background: p.accent }}
                  />
                </div>
                <span className="text-xs text-gray-300">{p.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Accent picker */}
      <div>
        <p className="mb-2 text-xs uppercase tracking-wider text-gray-500">Accent color</p>
        <div className="flex flex-wrap items-center gap-2">
          {ACCENT_SWATCHES.map((hex) => {
            const active = sameHex(hex, accent);
            return (
              <button
                key={hex}
                onClick={() => selectAccent(hex)}
                title={hex}
                className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${
                  active ? 'border-stack-white' : 'border-transparent'
                }`}
                style={{ background: hex }}
              />
            );
          })}

          {/* Custom hex via native color input */}
          <label
            className="relative flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-gray-700 px-2.5 text-xs text-gray-400 hover:border-gray-600"
            title="Pick a custom color"
          >
            <span
              className="h-3.5 w-3.5 rounded-full border border-black/20"
              style={{ background: accent }}
            />
            <span className="mono">{accent.toUpperCase()}</span>
            <input
              type="color"
              value={accent}
              onChange={(e) => selectAccent(e.target.value)}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </label>
        </div>
      </div>
    </div>
  );
}
