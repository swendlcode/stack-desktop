import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollArea } from '../ui/ScrollArea';
import { LibraryTree } from '../library/LibraryTree';
import { SidebarFolderRow } from './SidebarFolderRow';
import { useUiStore, MIN_WIDTH, type ActivePage } from '../../stores/uiStore';
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
import { LogoIcon, LogoWordmark } from '../ui/Logo';

const NAV_ITEMS: Array<{ id: ActivePage; label: string; icon: typeof Element3 }> = [
  { id: 'browser',   label: 'Browser',   icon: Element3    },
  { id: 'pack',      label: 'Packs',     icon: Folder      },
  { id: 'favorites', label: 'Favorites', icon: HeartAdd    },
  { id: 'presets',   label: 'Presets',   icon: DocumentText },
  { id: 'midi',      label: 'MIDI',      icon: Cpu         },
  { id: 'plugins',   label: 'Plugins',   icon: MusicFilter },
  { id: 'projects',  label: 'Projects',  icon: MusicSquare },
];

export function Sidebar() {
  const activePage = useUiStore((s) => s.activePage);
  const showPluginsNav = useUiStore((s) => s.showPluginsNav);
  const showProjectsNav = useUiStore((s) => s.showProjectsNav);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const setActivePage = useUiStore((s) => s.setActivePage);
  const favoriteStackId = useUiStore((s) => s.favoriteStackId);
  const setFavoriteStackId = useUiStore((s) => s.setFavoriteStackId);
  const setPathPrefix = useFilterStore((s) => s.setPathPrefix);
  const { data: stacks = [] } = useStacks();
  const [favoritesExpanded, setFavoritesExpanded] = useState(true);
  const navItems = NAV_ITEMS.filter((item) => {
    if (item.id === 'plugins' && !showPluginsNav) return false;
    if (item.id === 'projects' && !showProjectsNav) return false;
    return true;
  });

  // ── Drag-to-resize ────────────────────────────────────────────────────────
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      const newWidth = startWidthRef.current + delta;
      
      // If dragged below minimum width, collapse the sidebar
      if (newWidth < MIN_WIDTH) {
        if (sidebarOpen) {
          toggleSidebar();
        }
      } else {
        // If dragged above minimum width and sidebar is collapsed, expand it
        if (!sidebarOpen) {
          toggleSidebar();
        }
        setSidebarWidth(newWidth);
      }
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [setSidebarWidth, sidebarOpen, toggleSidebar]);

  // ── Collapsed state — icon-only strip ────────────────────────────────────
  if (!sidebarOpen) {
    return (
      <aside className="relative flex w-12 shrink-0 flex-col items-center border-r border-gray-700 bg-gray-900 py-2 gap-1">
        {/* Logo icon only */}
        <div className="flex h-8 w-8 items-center justify-center">
          <LogoIcon height={18} className="w-auto select-none" />
        </div>

        <div className="my-1 w-6 border-t border-gray-700" />

        {/* Nav icons */}
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activePage === item.id;
          return (
            <button
              key={item.id}
              onClick={() => {
                // Clicking Browser or Projects always exits any drilled-in
                // view: Browser clears the path prefix; Projects also clears
                // it so users can re-click "Projects" while inside a project
                // to bounce back to the projects grid.
                if (item.id === 'browser' || item.id === 'projects') {
                  setPathPrefix(null);
                }
                setActivePage(item.id);
              }}
              title={item.label}
              className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                active
                  ? 'bg-stack-fire/10 text-stack-fire'
                  : 'text-gray-500 hover:bg-gray-800 hover:text-stack-white'
              }`}
            >
              <Icon size={16} color="currentColor" variant={active ? 'Bulk' : 'Linear'} />
            </button>
          );
        })}

        {/* Drag handle — right edge */}
        <div
          onMouseDown={onMouseDown}
          onDoubleClick={() => {
            toggleSidebar();
            setSidebarWidth(240);
          }}
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize transition-colors hover:bg-stack-fire/40 active:bg-stack-fire/60"
          title="Drag to expand · Double-click to expand"
        />
      </aside>
    );
  }

  // ── Expanded state ────────────────────────────────────────────────────────
  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-gray-700 bg-gray-900"
      style={{ width: sidebarWidth }}
    >
      {/* Header row: logo only */}
      <div className="flex items-center px-4 pb-1 pt-3">
        <LogoWordmark height={20} className="w-auto select-none" />
      </div>

      {/* Nav */}
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
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5"
                >
                  <Icon size={16} color="currentColor" variant={rowActive ? 'Bulk' : 'Linear'} />
                  <span className="truncate">{item.label}</span>
                </button>
                {hasFolders && (
                  <button
                    onClick={() => setFavoritesExpanded((v) => !v)}
                    className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-700/60 hover:text-stack-white"
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
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="mt-2 h-px bg-gray-700 w-full mx-0" />

      <ScrollArea className="flex-1">
        <LibraryTree />
      </ScrollArea>

      {/* Drag handle — right edge */}
      <div
        onMouseDown={onMouseDown}
        onDoubleClick={() => setSidebarWidth(240)}
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize transition-colors hover:bg-stack-fire/40 active:bg-stack-fire/60"
        title="Drag to resize · Double-click to reset"
      />
    </aside>
  );
}
