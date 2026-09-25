import { useState } from 'react';
import { SidebarFolderRow } from './SidebarFolderRow';
import { useUiStore, type ActivePage } from '../../stores/uiStore';
import { useFilterStore } from '../../stores/filterStore';
import { useStacks } from '../../hooks/useStacks';
import {
  Element3,
  Folder,
  HeartAdd,
  DocumentText,
  Cpu,
  MusicSquare,
  MusicFilter,
  ArrowDown2,
  ArrowRight2,
} from '../ui/icons';

export const NAV_ITEMS: Array<{ id: ActivePage; label: string; icon: typeof Element3 }> = [
  { id: 'browser',   label: 'Browser',   icon: Element3    },
  { id: 'pack',      label: 'Packs',     icon: Folder      },
  { id: 'favorites', label: 'Favorites', icon: HeartAdd    },
  { id: 'presets',   label: 'Presets',   icon: DocumentText },
  { id: 'midi',      label: 'MIDI',      icon: Cpu         },
  { id: 'plugins',   label: 'Plugins',   icon: MusicFilter },
  { id: 'projects',  label: 'Projects',  icon: MusicSquare },
];

/** The nav items the user has switched on, in display order. */
export function useVisibleNavItems() {
  const showPluginsNav = useUiStore((s) => s.showPluginsNav);
  const showProjectsNav = useUiStore((s) => s.showProjectsNav);
  return NAV_ITEMS.filter((item) => {
    if (item.id === 'plugins' && !showPluginsNav) return false;
    if (item.id === 'projects' && !showProjectsNav) return false;
    return true;
  });
}

/**
 * The labelled nav list, shared by the desktop sidebar and the mobile drawer.
 * Rows are taller below `md` so they clear the ~40px touch-target floor;
 * at `md` and up they keep the original compact desktop geometry.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const activePage = useUiStore((s) => s.activePage);
  const setActivePage = useUiStore((s) => s.setActivePage);
  const favoriteStackId = useUiStore((s) => s.favoriteStackId);
  const setFavoriteStackId = useUiStore((s) => s.setFavoriteStackId);
  const setPathPrefix = useFilterStore((s) => s.setPathPrefix);
  const { data: stacks = [] } = useStacks();
  const [favoritesExpanded, setFavoritesExpanded] = useState(true);
  const navItems = useVisibleNavItems();

  return (
    <nav className="flex flex-col gap-0.5 px-2 pt-1">
      {navItems.map((item) => {
        const Icon = item.icon;
        const active = activePage === item.id;
        const isFavorites = item.id === 'favorites';
        const hasFolders = isFavorites && stacks.length > 0;
        // Favorites row is only "active" (accent) when showing All Favorites;
        // a selected folder highlights its own child row instead.
        const rowActive = isFavorites ? active && favoriteStackId === null : active;

        return (
          <div key={item.id}>
            <div
              className={`group flex items-center rounded-md text-sm transition-colors ${
                rowActive
                  ? 'bg-stack-fire/10 text-stack-fire'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-stack-white'
              }`}
            >
              <button
                onClick={() => {
                  // Clicking Browser or Projects always exits any drilled-in
                  // view: Browser clears the path prefix; Projects also clears
                  // it so users can re-click "Projects" while inside a project
                  // to bounce back to the projects grid.
                  if (item.id === 'browser' || item.id === 'projects') {
                    setPathPrefix(null);
                  }
                  if (isFavorites) setFavoriteStackId(null);
                  setActivePage(item.id);
                  onNavigate?.();
                }}
                className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2.5 md:py-1.5"
              >
                <Icon size={16} color="currentColor" variant={rowActive ? 'Bulk' : 'Linear'} />
                <span className="truncate">{item.label}</span>
              </button>
              {hasFolders && (
                <button
                  onClick={() => setFavoritesExpanded((v) => !v)}
                  className="mr-1 flex h-10 w-10 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-700/60 hover:text-stack-white md:h-6 md:w-6"
                  aria-label={favoritesExpanded ? 'Collapse favorites' : 'Expand favorites'}
                >
                  {favoritesExpanded ? (
                    <ArrowDown2 size={13} color="currentColor" variant="Linear" />
                  ) : (
                    <ArrowRight2 size={13} color="currentColor" variant="Linear" />
                  )}
                </button>
              )}
            </div>

            {isFavorites && hasFolders && favoritesExpanded && (
              <div className="mb-0.5 mt-0.5 flex flex-col gap-0.5">
                {stacks.map((stack) => (
                  <SidebarFolderRow
                    key={stack.id}
                    stack={stack}
                    isActive={active && favoriteStackId === stack.id}
                    onSelect={(id) => {
                      setFavoriteStackId(id);
                      setActivePage('favorites');
                      onNavigate?.();
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
