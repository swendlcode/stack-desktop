import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { notifyScrollActivity } from '../../hooks/useScrollActivity';
import { useShallow } from 'zustand/react/shallow';
import { useQuery } from '@tanstack/react-query';
import type { Asset, Settings } from '../../types';
import { AssetRow } from './AssetRow';
import { AssetColumnHeader, type AssetViewType } from './AssetColumnHeader';
import { ResultsHeader } from '../browser/ResultsHeader';
import { usePlayerStore } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { audioEngine } from '../../services/audioEngine';
import { settingsService } from '../../services/settingsService';
import { ArrowLeft2, ArrowRight2 } from '../ui/icons';
interface AssetGridProps {
  assets: Asset[];
  onOpenDetail?: (asset: Asset) => void;
  page: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (page: number) => void;
  /** Drives which columns appear in the header and rows. */
  viewType?: AssetViewType;
  /** Optional shared scroll container for non-sticky page headers. */
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  /** Set false when the parent renders ResultsHeader externally. */
  showResultsHeader?: boolean;
  /** Set false when the parent renders AssetColumnHeader externally. */
  showColumnHeader?: boolean;
}

// How long a page-jump takes. Short enough to keep up with a held arrow key,
// long enough that the eye follows the list instead of being teleported.
const SCROLL_ANIM_MS = 200;
// A click-driven scroll waits out the double-click window before it moves.
// The list moving between the two clicks of a double-click sends the second
// one to a different row, which opens the wrong sample's details.
const POINTER_SCROLL_DELAY_MS = 320;
const ROW_HEIGHT = 64;
const COMPACT_ROW_HEIGHT = 40;
const FOOTER_HEIGHT = 52;

export function AssetGrid({
  assets,
  onOpenDetail,
  page,
  pageSize,
  totalCount,
  onPageChange,
  viewType = 'sample',
  scrollContainerRef,
  showResultsHeader = true,
  showColumnHeader = true,
}: AssetGridProps) {
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const listViewportRef = useRef<HTMLDivElement | null>(null);
  const setPlaylist = usePlayerStore((s) => s.setPlaylist);
  // currentAsset still needed for selectedIndex sync effect below
  const currentAsset = usePlayerStore((s) => s.currentAsset);
  const editorAssetId = useUiStore((s) => s.editorAssetId);
  const openEditor = useUiStore((s) => s.openEditor);
  const editorHeight = useUiStore((s) => s.editorHeight);

  const { data: settings } = useQuery<Settings>({
    queryKey: ['settings'],
    queryFn: () => settingsService.getSettings(),
    staleTime: Infinity,
  });
  const showWaveform = settings?.showWaveform ?? true;
  const showBpmBadge = settings?.showBpmBadge ?? true;
  const showKeyBadge = settings?.showKeyBadge ?? true;
  const showTimeBadge = settings?.showTimeBadge ?? true;
  const showFolderColumn = settings?.showFolderColumn ?? false;
  const compactList = settings?.compactList ?? false;

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const selectedIndexRef = useRef<number | null>(null);
  const setSelectedIndexSync = useCallback((idx: number | null) => {
    selectedIndexRef.current = idx;
    setSelectedIndex(idx);
  }, []);
  const [scrollMargin, setScrollMargin] = useState(0);
  const prevEditorHeight = useRef(editorHeight);

  // Multi-select state
  const { selectedIds, toggleId, selectRange, clearSelection } = useSelectionStore(
    useShallow((s) => ({
      selectedIds: s.selectedIds,
      toggleId: s.toggleId,
      selectRange: s.selectRange,
      clearSelection: s.clearSelection,
    })),
  );
  // Track the last index clicked without modifier for Shift+click range anchor
  const lastClickedIndexRef = useRef<number | null>(null);

  // Only materialized when there's an active multi-selection — lets a
  // dragged row that's part of it carry the whole selection instead of
  // just itself (see AssetRow's onDragStart).
  const multiSelectedAssets = useMemo(
    () => (selectedIds.size > 1 ? assets.filter((a) => selectedIds.has(a.id)) : null),
    [assets, selectedIds],
  );

  // Sync scroll position with editor height changes so it "pushes" content up
  useEffect(() => {
    const scrollEl = scrollContainerRef?.current ?? internalScrollRef.current;
    if (scrollEl && editorAssetId !== null) {
      const delta = editorHeight - prevEditorHeight.current;
      if (delta !== 0) {
        scrollEl.scrollBy({ top: delta });
      }
    }
    prevEditorHeight.current = editorHeight;
  }, [editorHeight, editorAssetId, scrollContainerRef]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const pageWindowStart = Math.floor((page - 1) / 10) * 10 + 1;
  const pageWindowEnd = Math.min(pageWindowStart + 9, totalPages);
  const visiblePages = Array.from(
    { length: pageWindowEnd - pageWindowStart + 1 },
    (_, i) => pageWindowStart + i
  );

  // Keep playlist in sync so PlayerBar prev/next works
  useEffect(() => {
    setPlaylist(assets);
    // Pre-decode the first few tracks whenever the list changes
    audioEngine.prefetchAround(assets, 0);
  }, [assets, setPlaylist]);

  /**
   * Distance from the top of the scrolled CONTENT to the top of the list.
   *
   * `scrollTop` is the whole point. Two rects alone give the distance on
   * *screen*, which shrinks as you scroll and goes negative the moment the
   * hero and toolbar pass the top edge — where `Math.max(0, …)` pinned it to
   * zero. Every virtual row is then positioned by `start - 0` instead of
   * `start - margin`, so the list is pushed down by the height of everything
   * above it: a screen-high blank gap, the rows shoved off the bottom, and
   * the row you were arrowing through nowhere to be seen.
   *
   * It only went wrong when something re-measured while scrolled, which is
   * why it took entering full screen or changing the interface zoom to
   * trigger it. Adding `scrollTop` makes the measurement independent of
   * where the list happens to be scrolled to.
   */
  const measureScrollMargin = useCallback(() => {
    const el = scrollContainerRef?.current;
    if (!el || !listViewportRef.current) {
      setScrollMargin(0);
      return;
    }
    const containerRect = el.getBoundingClientRect();
    const listRect = listViewportRef.current.getBoundingClientRect();
    const margin = Math.max(
      0,
      Math.round(listRect.top - containerRect.top + el.scrollTop)
    );
    setScrollMargin((prev) => (prev === margin ? prev : margin));
  }, [scrollContainerRef]);

  useEffect(() => {
    measureScrollMargin();
    window.addEventListener('resize', measureScrollMargin);
    // Interface scale changes the layout without necessarily resizing the
    // window, and anything above the list changing height moves it too.
    window.addEventListener('stack:zoom-changed', measureScrollMargin);
    const el = scrollContainerRef?.current;
    const ro = el ? new ResizeObserver(() => measureScrollMargin()) : null;
    if (el && ro) {
      ro.observe(el);
      // The content wrapper grows and shrinks with the hero and toolbar.
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    return () => {
      window.removeEventListener('resize', measureScrollMargin);
      window.removeEventListener('stack:zoom-changed', measureScrollMargin);
      ro?.disconnect();
    };
  }, [measureScrollMargin, scrollContainerRef]);

  const virtualizer = useVirtualizer({
    count: assets.length,
    getScrollElement: () => scrollContainerRef?.current ?? internalScrollRef.current,
    estimateSize: () => (compactList ? COMPACT_ROW_HEIGHT : ROW_HEIGHT),
    // A trackpad flick moves the list faster than React can mount rows, and
    // whatever is not mounted yet is blank. Ten rows of buffer ran out during
    // an ordinary fling; this is roughly a screen's worth on either side,
    // which is what makes a fast scroll read as continuous.
    overscan: 24,
    scrollMargin,
  });

  // Tell the waveform cells to hold their fetches while this is moving.
  useEffect(() => {
    const el = scrollContainerRef?.current ?? internalScrollRef.current;
    if (!el) return;
    const onScroll = () => notifyScrollActivity();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollContainerRef]);

  // Cached row measurements go stale when density flips.
  useEffect(() => {
    virtualizer.measure();
  }, [compactList, virtualizer]);

  // Set on pointer clicks so the scroll-into-view effect below knows the
  // selection came from the mouse rather than from the keyboard.
  const lastPointerSelectRef = useRef(0);
  // Tells "the selection moved" apart from "the view changed shape under a
  // selection that did not move" — the editor opening is the second kind.
  const prevSelectedIndexRef = useRef<number | null>(null);

  /**
   * How much of the top of the scroll container is covered by something
   * pinned over it.
   *
   * The list does not get the whole container. The toolbar band and the
   * column header are `position: sticky` *inside* it, so they sit on top of
   * the rows rather than beside them, and the first ~170px of the container
   * shows whatever is pinned there, not the list.
   *
   * Scrolling a row to `scrollTop = rowTop` therefore does not put it at the
   * top of the view — it puts it *behind the toolbar*, four rows up from the
   * first thing the user can see. That is the whole of "I moved fast and the
   * playing sample is now above and I cannot see it": the page jump was
   * landing the selection under the header every time.
   *
   * Measured rather than assumed, because the band's height depends on the
   * window width (the filter chips wrap), on the interface scale, and on
   * whether the user has turned the sticky toolbar off at all.
   */
  const stickyInset = useCallback(() => {
    const el = scrollContainerRef?.current ?? internalScrollRef.current;
    if (!el) return 0;
    const marked = Array.from(el.querySelectorAll<HTMLElement>('[data-sticky-overlay]'));
    // The column header is nested inside the toolbar band when that band is
    // sticky, and they pin as one. Counting both would double the inset.
    const outer = marked.filter((n) => !marked.some((o) => o !== n && o.contains(n)));
    // Two pinned siblings would overlap rather than stack, so the deepest one
    // is the inset, not the sum.
    return outer.reduce((m, n) => Math.max(m, n.offsetHeight), 0);
  }, [scrollContainerRef]);

  /**
   * Animated scrolling, and the pending destination.
   *
   * An instant jump is correct and reads as a glitch — the list is simply
   * somewhere else and the eye has to find its place again. Easing the same
   * distance over a fifth of a second reads as the list being pulled along.
   *
   * `to` is the other half of it. During the animation `scrollTop` is a
   * position part-way there, so a second keypress would compare against it,
   * decide the row was still off screen and start another animation on top —
   * the stutter this is meant to remove. While a scroll is in flight, the
   * destination is the truth about where the view is.
   */
  const scrollAnimRef = useRef<{ raf: number; to: number } | null>(null);
  const pointerScrollTimerRef = useRef<number | null>(null);

  const cancelScrollAnim = useCallback(() => {
    if (pointerScrollTimerRef.current !== null) {
      clearTimeout(pointerScrollTimerRef.current);
      pointerScrollTimerRef.current = null;
    }
    if (!scrollAnimRef.current) return;
    cancelAnimationFrame(scrollAnimRef.current.raf);
    scrollAnimRef.current = null;
  }, []);

  const animateScrollTo = useCallback(
    (el: HTMLElement, rawTo: number) => {
      // Past the end of the content the browser clamps `scrollTop` itself, so
      // an unclamped target makes the easing run out against a wall: the last
      // third of the animation moves nothing and the list looks like it stuck.
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      const to = Math.min(Math.max(0, rawTo), max);
      // Already on its way to the same place. Restarting would re-ease from
      // the current position, which is a visible hitch for no movement — and
      // this effect re-runs for things that have nothing to do with the
      // selection, such as the list being re-measured.
      if (scrollAnimRef.current && Math.abs(scrollAnimRef.current.to - to) < 1) return;
      const from = el.scrollTop;
      const distance = to - from;
      cancelScrollAnim();
      if (Math.abs(distance) < 1) return;
      const startedAt = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - startedAt) / SCROLL_ANIM_MS);
        // Fast at first, settling at the end — the shape of something being
        // pulled rather than driven.
        const eased = 1 - (1 - t) ** 3;
        el.scrollTop = from + distance * eased;
        scrollAnimRef.current = t < 1 ? { raf: requestAnimationFrame(step), to } : null;
      };
      scrollAnimRef.current = { raf: requestAnimationFrame(step), to };
    },
    [cancelScrollAnim],
  );

  // The user's own scrolling always wins. Without this, a wheel flick during
  // a page jump fights the animation for the same scrollTop.
  useEffect(() => {
    const el = scrollContainerRef?.current ?? internalScrollRef.current;
    if (!el) return;
    const stop = () => cancelScrollAnim();
    el.addEventListener('wheel', stop, { passive: true });
    el.addEventListener('pointerdown', stop, { passive: true });
    return () => {
      el.removeEventListener('wheel', stop);
      el.removeEventListener('pointerdown', stop);
      cancelScrollAnim();
    };
  }, [cancelScrollAnim, scrollContainerRef]);

  /**
   * Keep the selected row on screen — one page at a time, not one row at a
   * time (keyboard / external selection only).
   *
   * Three things have been wrong here in turn, and the third is why this
   * looks the way it does now.
   *
   * It used to nudge the row just far enough to clear a guard band, so
   * arrowing down walked the selection to the bottom edge and pinned it
   * there with everything it was moving towards off screen. Then it ran
   * inside a `requestAnimationFrame` whose cleanup cancelled it on every
   * change — holding an arrow key changes the selection faster than once per
   * frame, so each pending frame was cancelled by the next keypress and the
   * scroll never ran at all while the key was held.
   *
   * Centring every row fixed both and is still wrong at speed: it depends on
   * reading `getBoundingClientRect()` for a row the virtualizer may not have
   * mounted yet, and it moves the list on every single press, so a fast run
   * is a continuously sliding list that the eye cannot track. It lands the
   * row in the middle but asks you to read a moving target.
   *
   * Now the list holds still while the selection travels down it, and when
   * the selection reaches the bottom the view pages so that row becomes the
   * first *visible* one. "Visible" is the word that was missing: the toolbar
   * band is pinned over the top of this same scroll container, so a row
   * scrolled to `scrollTop = rowTop` lands behind it, four rows above
   * anything the user can see. Moving fast therefore ended with the playing
   * sample off the top of the screen. `stickyInset()` is what makes the
   * arithmetic agree with the picture. The geometry is pure arithmetic — rows are a fixed height, so
   * the row's offset is known without touching the DOM. Nothing here depends
   * on the row being mounted, on a rect being up to date, or on how fast the
   * keys repeat, and running it twice for the same selection changes
   * nothing. That is what makes it survive a held arrow key.
   */
  useLayoutEffect(() => {
    if (selectedIndex === null || selectedIndex < 0 || selectedIndex >= assets.length) return;
    const scrollEl = scrollContainerRef?.current ?? internalScrollRef.current;
    if (!scrollEl) return;

    const viewHeight = scrollEl.clientHeight;
    if (viewHeight <= 0) return;

    const rowHeight = compactList ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
    const rowTop = scrollMargin + selectedIndex * rowHeight;
    const rowBottom = rowTop + rowHeight;
    // Where the view is *going*, if it is already on its way somewhere.
    const scrollPos = scrollAnimRef.current?.to ?? scrollEl.scrollTop;
    // What the user can actually see: the container minus whatever is pinned
    // over the top of it.
    const inset = stickyInset();
    const viewTop = scrollPos + inset;
    const viewBottom = scrollPos + viewHeight;

    // A row the user just pointed at is under their cursor by definition, so
    // it only gets scrolled if it is genuinely off screen — never for being
    // close to an edge, which would pull it out from under them. There is no
    // dead window where nothing scrolls: a row that is fully outside the
    // view always moves, however recent the click.
    const fromPointer = performance.now() - lastPointerSelectRef.current < 400;
    const selectionChanged = selectedIndex !== prevSelectedIndexRef.current;
    prevSelectedIndexRef.current = selectedIndex;

    // One row of air at each edge, so the selection never sits flush against
    // the edge waiting to disappear and the next press has somewhere to go.
    const guard = rowHeight;

    /**
     * A page jump is right for exactly one caller.
     *
     * Arrowing is a sustained movement in one direction: the list holding
     * still and then paging is what lets the eye keep up. Nothing else here
     * is that. Clicking the last visible row should bring the next few into
     * reach, not throw the row you are pointing at to the top of the screen;
     * and the editor opening — which takes 280px off the bottom of the view
     * without the selection changing at all — should give back just enough
     * room to see the row again. Both of those move the list by a row or
     * two. Paging on them is what "the scroll tricks me" was.
     */
    const page = selectionChanged && !fromPointer;

    const move = (to: number) => {
      // A click is not finished until the double-click window has passed.
      if (fromPointer && selectionChanged) {
        pointerScrollTimerRef.current = window.setTimeout(() => {
          pointerScrollTimerRef.current = null;
          animateScrollTo(scrollEl, to);
        }, POINTER_SCROLL_DELAY_MS);
        return;
      }
      animateScrollTo(scrollEl, to);
    };

    if (rowBottom + guard > viewBottom) {
      // Below the fold, or within a row of it.
      move(page ? rowTop - inset : rowBottom + guard - viewHeight);
    } else if (rowTop - guard < viewTop) {
      // Above the fold, or within a row of it.
      move(page ? rowBottom - viewHeight : rowTop - guard - inset);
    }

    return () => {
      if (pointerScrollTimerRef.current === null) return;
      clearTimeout(pointerScrollTimerRef.current);
      pointerScrollTimerRef.current = null;
    };
  }, [
    selectedIndex,
    assets.length,
    compactList,
    scrollMargin,
    scrollContainerRef,
    editorHeight,
    editorAssetId,
    animateScrollTo,
    stickyInset,
  ]);

  // When page changes, reset selection to first item and scroll to top.
  // Skip on initial mount — the parent page owns the initial scroll
  // position (its hero/toolbar live in the same scroll container, and
  // forcing the list to align: 'start' would scroll past them).
  const pageInitializedRef = useRef(false);
  useEffect(() => {
    if (!pageInitializedRef.current) {
      pageInitializedRef.current = true;
      return;
    }
    setSelectedIndexSync(0);
    measureScrollMargin();
    virtualizer.scrollToIndex(0, { align: 'start' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  /**
   * Give the list its focus back when the editor closes.
   *
   * Up and down are handled on the list element, not on the window, because
   * the grid is what owns the selection. That means they need focus — and
   * opening the editor moves focus into it, so closing the editor left focus
   * on nothing at all (the focused node had just been removed) and the arrow
   * keys did nothing until the user clicked a row. Closing a panel should put
   * the keyboard back where it was.
   */
  const editorWasOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = editorWasOpenRef.current;
    editorWasOpenRef.current = editorAssetId !== null;
    if (!wasOpen || editorAssetId !== null) return;
    // `preventScroll` because focusing a tall scrolled container otherwise
    // jumps it to wherever the browser thinks the focus ring belongs.
    listViewportRef.current?.focus({ preventScroll: true });
  }, [editorAssetId]);

  // Sync selectedIndex when currentAsset changes from outside (e.g. row click)
  useEffect(() => {
    if (!currentAsset) return;
    const idx = assets.findIndex((a) => a.id === currentAsset.id);
    if (idx !== -1) setSelectedIndexSync(idx);
  }, [currentAsset, assets, setSelectedIndexSync]);

  const playAsset = useCallback(
    (asset: Asset) => {
      // Read fresh state directly from store to avoid stale closure issues
      // during rapid arrow key navigation
      const { currentAsset: cur, isPlaying: playing, play, pause, resume } = usePlayerStore.getState();
      if (cur?.id === asset.id) {
        if (playing) pause();
        else resume();
      } else {
        play(asset);
      }
    },
    [] // no deps — always reads live state from store
  );

  /**
   * Handle row click for multi-select:
   * - Cmd/Ctrl+click: toggle the clicked asset in/out of selection
   * - Shift+click: range-select from last plain click to this one
   * - Plain click: clear multi-selection (normal single-row navigation)
   */
  const handleRowClick = useCallback(
    (index: number, e: React.MouseEvent) => {
      const asset = assets[index];
      if (!asset) return;
      lastPointerSelectRef.current = performance.now();

      const isMeta = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;

      if (isMeta) {
        // Toggle this asset in the multi-selection
        toggleId(asset.id);
        lastClickedIndexRef.current = index;
      } else if (isShift && lastClickedIndexRef.current !== null) {
        // Range select from anchor to current
        const from = Math.min(lastClickedIndexRef.current, index);
        const to = Math.max(lastClickedIndexRef.current, index);
        const rangeIds = assets.slice(from, to + 1).map((a) => a.id);
        selectRange(rangeIds);
      } else {
        // Plain click — clear multi-selection, let normal single-select take over
        if (selectedIds.size > 0) clearSelection();
        lastClickedIndexRef.current = index;
      }
    },
    [assets, toggleId, selectRange, clearSelection, selectedIds.size],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        // Read from ref to avoid stale closure when keys repeat faster than renders
        const current = selectedIndexRef.current ?? -1;
        const next = current + 1;

        if (next >= assets.length) {
          if (page < totalPages) onPageChange(page + 1);
          return;
        }

        setSelectedIndexSync(next);
        const asset = assets[next];
        if (asset) {
          const isEdited = editorAssetId !== null && asset.type === 'sample';
          if (isEdited) openEditor(asset.id);
          if (asset.type === 'sample' && !isEdited) audioEngine.playBuffer(asset.path, 0);
          playAsset(asset);
          audioEngine.prefetchAround(assets, next);
        }

      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const current = selectedIndexRef.current ?? 0;
        const next = current - 1;

        if (next < 0) {
          if (page > 1) onPageChange(page - 1);
          return;
        }

        setSelectedIndexSync(next);
        const asset = assets[next];
        if (asset) {
          const isEdited = editorAssetId !== null && asset.type === 'sample';
          if (isEdited) openEditor(asset.id);
          if (asset.type === 'sample' && !isEdited) audioEngine.playBuffer(asset.path, 0);
          playAsset(asset);
          audioEngine.prefetchAround(assets, next);
        }

      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const idx = selectedIndexRef.current;
        if (idx !== null) {
          const asset = assets[idx];
          if (asset) {
            const isEdited = editorAssetId !== null && asset.type === 'sample';
            if (isEdited) openEditor(asset.id);

            const state = usePlayerStore.getState();
            if (state.currentAsset?.id === asset.id) {
              state.isPlaying ? state.stop() : state.resume();
            } else {
              if (asset.type === 'sample' && !isEdited) {
                audioEngine.playBuffer(asset.path, 0);
              }
              playAsset(asset);
            }
          }
        }
      }
    },
    [assets, page, totalPages, onPageChange, playAsset, editorAssetId, openEditor, setSelectedIndexSync]
  );

  return (
    <div className="flex flex-col">
      {showResultsHeader && <ResultsHeader resultCount={totalCount} />}
      {showColumnHeader && (
        <AssetColumnHeader
          viewType={viewType}
          pageAssetIds={assets.map((a) => a.id)}
          showWaveform={showWaveform}
          showBpmBadge={showBpmBadge}
          showKeyBadge={showKeyBadge}
          showTimeBadge={showTimeBadge}
          showFolderColumn={showFolderColumn}
          compact={compactList}
        />
      )}

      {/* Scrollable list */}
      <div
        ref={(el) => {
          listViewportRef.current = el;
          if (!scrollContainerRef) internalScrollRef.current = el;
        }}
        className="outline-none focus:ring-0"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        // Any pointer press anywhere in the list counts as "the user is
        // aiming at a row", which suppresses the scroll-into-view below.
        // Marking this in `handleRowClick` alone was not enough: the play
        // button calls `stopPropagation`, so pressing play never recorded a
        // pointer selection, the list re-centred the newly playing row under
        // the cursor, and the next click landed on a different sample. With
        // the editor open the guard band is ~230px, so the jump was large.
        // Capture phase, so it runs before any handler that stops the event.
        onPointerDownCapture={() => {
          lastPointerSelectRef.current = performance.now();
        }}
        aria-label="Asset list — use arrow keys to navigate"
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize() + (totalPages > 1 ? FOOTER_HEIGHT : 0)}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const asset = assets[virtualRow.index];
            if (!asset) return null;
            return (
              <div
                key={asset.id}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                  // Each row is independent: a change inside one cannot affect
                  // the geometry of any other, so the browser does not need to
                  // consider the rest of the list when one re-renders. With
                  // dozens of rows mounted that is the difference between a
                  // scroll that glides and one that hitches.
                  contain: 'layout paint style',
                }}
              >
                <AssetRow
                  asset={asset}
                  isSelected={selectedIndex === virtualRow.index}
                  isMultiSelected={selectedIds.has(asset.id)}
                  dragSelection={selectedIds.has(asset.id) ? multiSelectedAssets : null}
                  isLast={virtualRow.index === assets.length - 1}
                  viewType={viewType}
                  onOpenDetail={onOpenDetail}
                  index={virtualRow.index}
                  onRowClick={handleRowClick}
                  showWaveform={showWaveform}
                  showBpmBadge={showBpmBadge}
                  showKeyBadge={showKeyBadge}
                  showTimeBadge={showTimeBadge}
                  showFolderColumn={showFolderColumn}
                  compact={compactList}
                />
              </div>
            );
          })}
          {totalPages > 1 && (
            <div
              style={{
                position: 'absolute',
                top: `${virtualizer.getTotalSize()}px`,
                left: 0,
                width: '100%',
                height: `${FOOTER_HEIGHT}px`,
              }}
              // No top rule. The last row already drops its own bottom border
              // and the pager is a bordered pill sitting in open space, so the
              // line only drew a second edge under a list that had already
              // ended.
              className="flex items-center justify-center px-3"
            >
              <div className="flex max-w-full items-center gap-1.5 overflow-x-auto rounded-lg border border-gray-700 bg-gray-900/90 px-2 py-1 max-md:scrollbar-none">
                <button
                  onClick={() => {
                    const newPage = page - 1;
                    onPageChange(newPage);
                    // Continue playback on the new page like arrow keys do
                    if (selectedIndex !== null && assets.length > 0) {
                      // Go to the last item of the previous page
                      const lastIndex = assets.length - 1;
                      setSelectedIndexSync(lastIndex);
                      const asset = assets[lastIndex];
                      if (asset && asset.type === 'sample') {
                        const isEdited = editorAssetId !== null;
                        if (isEdited) openEditor(asset.id);
                        if (!isEdited) audioEngine.playBuffer(asset.path, 0);
                        playAsset(asset);
                        audioEngine.prefetchAround(assets, lastIndex);
                      }
                    }
                  }}
                  disabled={page <= 1}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-800 hover:text-stack-white disabled:cursor-not-allowed disabled:opacity-35 md:h-7 md:w-7"
                  aria-label="Previous page"
                >
                  <ArrowLeft2 size={13} color="currentColor" variant="Linear" />
                </button>

                {visiblePages.map((p) => {
                  const active = p === page;
                  return (
                    <button
                      key={p}
                      onClick={() => onPageChange(p)}
                      className={`mono min-w-10 shrink-0 rounded px-2 py-2.5 text-xs transition-colors md:min-w-7 md:py-1 ${
                        active
                          ? 'bg-stack-fire text-stack-black'
                          : 'text-gray-300 hover:bg-gray-800 hover:text-stack-white'
                      }`}
                      aria-label={`Go to page ${p}`}
                    >
                      {p}
                    </button>
                  );
                })}

                <button
                  onClick={() => {
                    const newPage = page + 1;
                    onPageChange(newPage);
                    // Continue playback on the new page like arrow keys do
                    if (selectedIndex !== null && assets.length > 0) {
                      // Go to the first item of the next page
                      setSelectedIndexSync(0);
                      const asset = assets[0];
                      if (asset && asset.type === 'sample') {
                        const isEdited = editorAssetId !== null;
                        if (isEdited) openEditor(asset.id);
                        if (!isEdited) audioEngine.playBuffer(asset.path, 0);
                        playAsset(asset);
                        audioEngine.prefetchAround(assets, 0);
                      }
                    }
                  }}
                  disabled={page >= totalPages}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-800 hover:text-stack-white disabled:cursor-not-allowed disabled:opacity-35 md:h-7 md:w-7"
                  aria-label="Next page"
                >
                  <ArrowRight2 size={13} color="currentColor" variant="Linear" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
