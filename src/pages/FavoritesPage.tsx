import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { assetService } from '../services/assetService';
import { AssetGrid } from '../components/asset/AssetGrid';
import { FavoritesFolderStrip } from '../components/favorites/FavoritesFolderStrip';
import { DEFAULT_FILTERS, DEFAULT_SORT } from '../types';
import { assetQueryKeys } from '../hooks/useAssets';
import { useStacks, useStackAssets } from '../hooks/useStacks';
import { useUiStore } from '../stores/uiStore';

const PAGE_SIZE = 100;
const FAVORITES_FILTERS = { ...DEFAULT_FILTERS, favoritesOnly: true };

export function FavoritesPage() {
  const [page, setPage] = useState(1);
  // Selection lives in uiStore so the sidebar's expandable Favorites tree can
  // drive it too.
  const activeStackId = useUiStore((s) => s.favoriteStackId);
  const setActiveStackId = useUiStore((s) => s.setFavoriteStackId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const offset = (page - 1) * PAGE_SIZE;

  const { data: stacks = [] } = useStacks();
  const activeStack = useMemo(
    () => stacks.find((s) => s.id === activeStackId) ?? null,
    [stacks, activeStackId],
  );

  // Reset paging whenever the selected folder changes (incl. from the sidebar).
  useEffect(() => {
    setPage(1);
  }, [activeStackId]);

  const favoritesQuery = useQuery({
    queryKey: assetQueryKeys.search(FAVORITES_FILTERS, DEFAULT_SORT, PAGE_SIZE, offset),
    queryFn: () => assetService.search(FAVORITES_FILTERS, DEFAULT_SORT, PAGE_SIZE, offset),
    placeholderData: (prev) => prev,
    enabled: activeStackId === null,
  });
  const stackAssetsQuery = useStackAssets(activeStackId, PAGE_SIZE, offset);

  const assets = activeStackId === null ? (favoritesQuery.data?.assets ?? []) : (stackAssetsQuery.data ?? []);
  const total = activeStackId === null ? (favoritesQuery.data?.total ?? 0) : (activeStack?.assetCount ?? 0);
  const isLoading = activeStackId === null ? favoritesQuery.isLoading : stackAssetsQuery.isLoading;

  const handleSelectStack = (id: string | null) => {
    setActiveStackId(id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center border-b border-gray-700 px-6">
        <h2 className="text-lg font-bold text-stack-white">
          {activeStack ? activeStack.name : 'Favorites'}
        </h2>
        <div className="mono ml-auto text-xs text-gray-400">
          {total.toLocaleString()} {total === 1 ? 'item' : 'items'}
        </div>
      </div>
      <FavoritesFolderStrip activeStackId={activeStackId} onSelect={handleSelectStack} />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading && assets.length === 0 ? (
          <div className="flex h-full items-center justify-center text-gray-500">
            Loading...
          </div>
        ) : assets.length === 0 ? (
          <div className="flex h-full items-center justify-center text-gray-500">
            {activeStack
              ? 'This folder is empty. Drag a favorite sample here to add it.'
              : 'No favorites yet. Heart a sample to add it here.'}
          </div>
        ) : (
          <AssetGrid
            assets={assets}
            page={page}
            pageSize={PAGE_SIZE}
            totalCount={total}
            onPageChange={setPage}
            viewType="favorites"
            scrollContainerRef={scrollRef}
          />
        )}
      </div>
    </div>
  );
}
