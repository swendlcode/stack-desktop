import { useCallback, useEffect, useRef } from 'react';
import { ScrollArea } from '../ui/ScrollArea';
import { LibraryTree } from '../library/LibraryTree';
import { SidebarNav, useVisibleNavItems } from './SidebarNav';
import { useUiStore, MIN_WIDTH } from '../../stores/uiStore';
import { useFilterStore } from '../../stores/filterStore';
import { LogoIcon, LogoWordmark } from '../ui/Logo';

/**
 * The desktop sidebar. Hidden below `md` — at phone width the same nav is
 * presented by `MobileSidebar` as an off-canvas drawer, because the inline
 * pixel width here (and its drag-to-resize handle) has no sensible mobile
 * equivalent and would leave almost nothing for the content.
 */
export function Sidebar() {
  const activePage = useUiStore((s) => s.activePage);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const setActivePage = useUiStore((s) => s.setActivePage);
  const setPathPrefix = useFilterStore((s) => s.setPathPrefix);
  const navItems = useVisibleNavItems();

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
      <aside className="relative hidden w-12 shrink-0 flex-col items-center gap-1 border-r border-gray-700 bg-gray-900 py-2 md:flex">
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
      className="relative hidden shrink-0 flex-col border-r border-gray-700 bg-gray-900 md:flex"
      style={{ width: sidebarWidth }}
    >
      {/* Header row: logo only */}
      <div className="flex items-center px-4 pb-1 pt-3">
        <LogoWordmark height={20} className="w-auto select-none" />
      </div>

      <SidebarNav />

      <div className="mx-0 mt-2 h-px w-full bg-gray-700" />

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
