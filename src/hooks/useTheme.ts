import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsService } from '../services/settingsService';
import type { Settings } from '../types';
import { hexToTriplet, lighten } from '../theme/color';

export type Theme = 'dark' | 'light';

const SETTINGS_KEY = ['settings'] as const;
const LOCAL_KEY = 'stack:theme';
const ACCENT_KEY = 'stack:accent';

/**
 * Pulls the persisted theme + accent from settings and applies them to the
 * document element so Tailwind's CSS-variable-driven palette repaints the UI.
 *
 * The base mode is written as `<html data-theme>` (drives the neutral ramp);
 * the accent overrides the fire/accent vars inline. Both are also written
 * before React mounts (see main.tsx) using a localStorage shadow copy, so the
 * very first paint matches the user's choice instead of flashing the default.
 */
export function useTheme() {
  const { data: settings } = useQuery<Settings>({
    queryKey: SETTINGS_KEY,
    queryFn: () => settingsService.getSettings(),
  });

  useEffect(() => {
    if (!settings) return;
    const theme: Theme = settings.theme === 'light' ? 'light' : 'dark';
    applyTheme(theme, settings.accentColor);
  }, [settings?.theme, settings?.accentColor]);
}

/**
 * Hook-free helpers for the topbar quick-toggle and the theme settings page.
 * Optimistic flip — writes to the DOM and (via the caller) to react-query's
 * settings cache immediately, then persists via the service. The query
 * invalidation in the caller guarantees convergence if the persist fails.
 */
export function applyTheme(theme: Theme, accent?: string | null) {
  const el = document.documentElement;
  el.setAttribute('data-theme', theme);
  applyAccent(accent);
  try {
    localStorage.setItem(LOCAL_KEY, theme);
    if (accent) localStorage.setItem(ACCENT_KEY, accent);
    else localStorage.removeItem(ACCENT_KEY);
  } catch {
    /* private mode / quota — best effort only */
  }
}

/**
 * Overrides the accent CSS vars inline on <html>. Passing a falsy accent
 * removes the overrides so the stylesheet defaults (--stack-fire etc.) apply.
 */
function applyAccent(accent?: string | null) {
  const el = document.documentElement;
  const triplet = accent ? hexToTriplet(accent) : null;
  if (accent && triplet) {
    el.style.setProperty('--stack-fire', triplet);
    el.style.setProperty('--color-accent', `rgb(${triplet})`);
    el.style.setProperty('--color-accent-hover', lighten(accent, 0.18));
  } else {
    el.style.removeProperty('--stack-fire');
    el.style.removeProperty('--color-accent');
    el.style.removeProperty('--color-accent-hover');
  }
}

export function readPersistedTheme(): Theme {
  try {
    const v = localStorage.getItem(LOCAL_KEY);
    return v === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function readPersistedAccent(): string | null {
  try {
    return localStorage.getItem(ACCENT_KEY);
  } catch {
    return null;
  }
}

/** Optimistically patches the cached settings so the rest of the UI sees the change. */
export function patchCachedSettings(
  qc: ReturnType<typeof useQueryClient>,
  patch: Partial<Pick<Settings, 'theme' | 'accentColor'>>,
) {
  qc.setQueryData<Settings | undefined>(['settings'], (prev) =>
    prev ? { ...prev, ...patch } : prev,
  );
}
