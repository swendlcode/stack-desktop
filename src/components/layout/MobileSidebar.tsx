import { useEffect, useRef, useState } from 'react';
import { ScrollArea } from '../ui/ScrollArea';
import { LibraryTree } from '../library/LibraryTree';
import { SidebarNav } from './SidebarNav';
import { useUiStore } from '../../stores/uiStore';
import { useFilterStore } from '../../stores/filterStore';
import { LogoWordmark } from '../ui/Logo';
import { CloseCircle } from '../ui/icons';

/**
 * Off-canvas nav drawer for phone width (`md` and below). Always mounted so
 * the slide transition has something to animate and so the "close on
 * navigate" effect below never fires on its own mount; `md:hidden` keeps it
 * out of the desktop layout entirely.
 */
export function MobileSidebar() {
  const open = useUiStore((s) => s.mobileNavOpen);
  const setOpen = useUiStore((s) => s.setMobileNavOpen);
  const activePage = useUiStore((s) => s.activePage);
  const favoriteStackId = useUiStore((s) => s.favoriteStackId);
  const pathPrefix = useFilterStore((s) => s.filters.pathPrefix);

  // The nav + library tree are only built once the drawer has actually been
  // opened. The shell stays mounted for the slide transition, but a desktop
  // session never pays for a second copy of the folder tree.
  const [contentMounted, setContentMounted] = useState(false);
  useEffect(() => {
    if (open) setContentMounted(true);
  }, [open]);

  // Close whenever the user actually navigates. Watching the destination
  // rather than wiring a callback into every row means the library tree
  // (which sets `pathPrefix` + `activePage` itself) closes the drawer too.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setOpen(false);
  }, [activePage, favoriteStackId, pathPrefix, setOpen]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  return (
    <div className="md:hidden" aria-hidden={!open}>
      {/* Backdrop */}
      <div
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-black/60 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Library navigation"
        className={`fixed inset-y-0 left-0 z-50 flex w-[82vw] max-w-[320px] flex-col border-r border-gray-700 bg-gray-900 shadow-2xl transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <LogoWordmark height={20} className="w-auto select-none" />
          <button
            onClick={() => setOpen(false)}
            className="-mr-2 flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-800 hover:text-stack-white"
            aria-label="Close navigation"
          >
            <CloseCircle size={20} color="currentColor" variant="Linear" />
          </button>
        </div>

        {contentMounted && (
          <>
            <SidebarNav onNavigate={() => setOpen(false)} />

            <div className="mt-2 h-px w-full bg-gray-700" />

            <ScrollArea className="flex-1">
              <LibraryTree />
            </ScrollArea>
          </>
        )}
      </aside>
    </div>
  );
}
