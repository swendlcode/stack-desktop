import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { libraryService } from '../services/libraryService';
import { assetQueryKeys } from './useAssets';
import { packQueryKeys } from './usePacks';
import { libraryTreeKey } from './useLibraryTree';
import { usePacks } from './usePacks';
import type { Pack, SpliceLibrary, WatchedFolder } from '../types';

export const spliceDetectKey = ['splice-detect'] as const;
export const watchedFoldersKey = ['watched-folders'] as const;

/** Trailing-slash- and separator-insensitive form, for prefix comparisons. */
export function normalizeFolderPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Detection walks the filesystem, which is slow and almost never changes
 * between launches — hold the result for the session rather than re-probing
 * on every remount of the Splice page.
 */
export function useSpliceDetection() {
  return useQuery<SpliceLibrary | null>({
    queryKey: spliceDetectKey,
    queryFn: () => libraryService.detectSpliceLibrary(),
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
  });
}

/** Normalized paths of every watched folder registered as `kind = "splice"`. */
export function useSpliceRoots(): string[] {
  const { data: watchedFolders = [] } = useQuery<WatchedFolder[]>({
    queryKey: watchedFoldersKey,
    queryFn: () => libraryService.getWatchedFolders(),
  });
  return useMemo(
    () =>
      watchedFolders
        .filter((w) => w.kind === 'splice')
        .map((w) => normalizeFolderPath(w.path)),
    [watchedFolders]
  );
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * The packs that belong to an imported Splice library.
 *
 * The `kind` column on `packs` is stamped `"pack"` by the indexer regardless of
 * which watched folder the file came from, so membership is resolved by path
 * against the splice-kind watched roots. `kind === 'splice'` is honoured too,
 * in case a pack is ever written with it directly.
 */
export function useSplicePacks() {
  const { data: packs = [], isLoading } = usePacks();
  const spliceRoots = useSpliceRoots();

  const splicePacks = useMemo<Pack[]>(() => {
    if (spliceRoots.length === 0) {
      return packs.filter((p) => p.kind === 'splice');
    }
    return packs
      .filter((p) => {
        if (p.kind === 'splice') return true;
        if (p.kind === 'project') return false;
        const rp = normalizeFolderPath(p.rootPath);
        return spliceRoots.some((root) => isUnder(rp, root));
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [packs, spliceRoots]);

  return { splicePacks, spliceRoots, isLoading };
}

/**
 * Registers every detected `…/sounds/packs` directory and scans it.
 *
 * Sequential on purpose: each scan enqueues into the same bounded indexer pool,
 * and firing three full Splice roots at once only lengthens the queue.
 */
export function useImportSpliceLibrary() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (library: SpliceLibrary) => {
      for (const root of library.roots) {
        await libraryService.addSpliceFolder(root.path);
        await libraryService.scanFolder(root.path);
      }
      return library.roots.length;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: assetQueryKeys.all });
      qc.invalidateQueries({ queryKey: packQueryKeys.all });
      qc.invalidateQueries({ queryKey: libraryTreeKey });
      qc.invalidateQueries({ queryKey: watchedFoldersKey });
      qc.invalidateQueries({ queryKey: ['facets'] });
    },
  });
}
