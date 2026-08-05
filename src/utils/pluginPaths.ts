const CUSTOM_PLUGIN_PATHS_KEY = 'stack:customPluginPaths';

export function loadCustomPluginPaths(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_PLUGIN_PATHS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function saveCustomPluginPaths(paths: string[]) {
  try {
    localStorage.setItem(CUSTOM_PLUGIN_PATHS_KEY, JSON.stringify(paths));
  } catch {
    // localStorage unavailable — custom folders just won't persist.
  }
}
