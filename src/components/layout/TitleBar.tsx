import { useUiStore } from '../../stores/uiStore';
import { useFilterStore } from '../../stores/filterStore';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Setting2, Sun, Moon } from '../ui/icons';
import { FolderPicker } from '../library/FolderPicker';
import { UpdateBadge } from './UpdateBadge';
import { SmartSearch } from '../browser/SmartSearch';
import { useSearch } from '../../hooks/useSearch';
import { settingsService } from '../../services/settingsService';
import { applyTheme, patchCachedSettings } from '../../hooks/useTheme';
import type { Settings } from '../../types';

export function TitleBar() {
  const activePage = useUiStore((s) => s.activePage);
  const setActivePage = useUiStore((s) => s.setActivePage);
  const setPathPrefix = useFilterStore((s) => s.setPathPrefix);
  const [draft, setDraft] = useSearch();
  const qc = useQueryClient();
  const { data: settings } = useQuery<Settings>({
    queryKey: ['settings'],
    queryFn: () => settingsService.getSettings(),
  });
  const theme = settings?.theme === 'light' ? 'light' : 'dark';

  const settingsActive = activePage === 'settings';
  const startWindowDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    getCurrentWindow().startDragging().catch(() => {});
  };

  // Optimistic flip: paint instantly via DOM + cache, then persist.
  // The loud caveat is that if persist fails, the next settings refetch will
  // overwrite the cache and revert the toggle — but that's the right outcome
  // (user sees what's actually saved).
  const toggleTheme = () => {
    if (!settings) return;
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next, settings.accentColor);
    patchCachedSettings(qc, { theme: next });
    settingsService
      .updateSettings({ ...settings, theme: next })
      .then((updated) => qc.setQueryData(['settings'], updated))
      .catch(() => {
        qc.invalidateQueries({ queryKey: ['settings'] });
      });
  };

  return (
    <div className="relative grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-gray-700 bg-gray-900 px-4">
      {/* Full-width drag layer under controls (Chrome-style pattern) */}
      <div
        data-tauri-drag-region
        onMouseDown={startWindowDrag}
        className="absolute inset-0 z-0 cursor-default"
      />

      {/* Foreground content sits above drag layer */}
      <div className="z-10 h-full pointer-events-none" />

      {/* Search — centered */}
      <div className="z-10 flex justify-center pointer-events-none">
        <SmartSearch
          id="global-search"
          className="no-drag pointer-events-auto w-[min(640px,52vw)]"
          value={draft}
          onChange={(next) => {
            setDraft(next);
            setPathPrefix(null);
            if (activePage !== 'browser') setActivePage('browser');
          }}
        />
      </div>

      {/* Add folder + Theme + Settings — right */}
      <div className="z-10 flex items-center justify-end pointer-events-none">
        <div className="no-drag pointer-events-auto flex items-center gap-3">
          <UpdateBadge />
          <FolderPicker />
          <button
            onClick={toggleTheme}
            disabled={!settings}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-800 hover:text-stack-white disabled:opacity-40"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? (
              <Sun size={18} color="currentColor" variant="Linear" />
            ) : (
              <Moon size={18} color="currentColor" variant="Linear" />
            )}
          </button>
          <button
            onClick={() =>
              setActivePage(settingsActive ? 'browser' : 'settings')
            }
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
              settingsActive
                ? 'bg-stack-fire/10 text-stack-fire'
                : 'text-gray-400 hover:bg-gray-800 hover:text-stack-white'
            }`}
            aria-label="Settings"
            title="Settings"
          >
            <Setting2
              size={18}
              color="currentColor"
              variant={settingsActive ? 'Bulk' : 'Linear'}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
