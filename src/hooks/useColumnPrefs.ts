import { useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsService } from '../services/settingsService';
import type { Settings } from '../types';

type ColumnKey =
  | 'showWaveform'
  | 'showTimeBadge'
  | 'showKeyBadge'
  | 'showBpmBadge'
  | 'showFolderColumn'
  | 'compactList';

/**
 * Column visibility / density preferences for the asset list. Backed by the
 * shared Settings record so the SettingsPage toggles and the column-header
 * context menu stay in sync.
 */
export function useColumnPrefs() {
  const qc = useQueryClient();
  const { data: settings } = useQuery<Settings>({
    queryKey: ['settings'],
    queryFn: () => settingsService.getSettings(),
    staleTime: Infinity,
  });

  const toggle = (key: ColumnKey) => {
    if (!settings) return;
    const updated: Settings = { ...settings, [key]: !settings[key] };
    qc.setQueryData(['settings'], updated);
    settingsService.updateSettings(updated).catch(() => {
      qc.setQueryData(['settings'], settings);
    });
  };

  return { settings, toggle };
}
