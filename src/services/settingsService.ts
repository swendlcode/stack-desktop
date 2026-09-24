import { invoke } from '@tauri-apps/api/core';
import type { Settings, WebAccessInfo } from '../types';

export const settingsService = {
  getSettings(): Promise<Settings> {
    return invoke('get_settings');
  },

  updateSettings(settings: Settings): Promise<Settings> {
    return invoke('update_settings', { settings });
  },

  /** Reachable browser URLs (token included) + live state of the HTTP server. */
  getWebAccessInfo(): Promise<WebAccessInfo> {
    return invoke('get_web_access_info');
  },

  /** Reads the real OS autostart state and syncs it into the persisted settings. */
  syncAutostart(): Promise<boolean> {
    return invoke('sync_autostart');
  },
};
