import { invoke } from '@tauri-apps/api/core';
import type { DeleteReport, LeftoverReport, PluginEntry, PluginFormat } from '../types';

export const pluginService = {
  scanPlugins(formats: PluginFormat[], extraPaths: string[]): Promise<PluginEntry[]> {
    return invoke('scan_plugins', { formats, extraPaths });
  },

  findPluginLeftovers(pluginPath: string, extraPaths: string[]): Promise<LeftoverReport> {
    return invoke('find_plugin_leftovers', { pluginPath, extraPaths });
  },

  deletePlugin(
    paths: string[],
    registryKeys: string[],
    extraRoots: string[],
  ): Promise<DeleteReport> {
    return invoke('delete_plugin', { paths, registryKeys, extraRoots });
  },
};
