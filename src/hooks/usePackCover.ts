import { useQuery } from '@tanstack/react-query';
import { convertFileSrc } from '@tauri-apps/api/core';
import { packService } from '../services/packService';
import { packQueryKeys } from './usePacks';

/**
 * Resolves the cover art URL for a given pack root path.
 * Returns a URL usable in <img src> via Tauri's asset protocol.
 * A `?v=<ts>` cache-buster is appended so overwriting the same file path
 * (e.g. replacing cover.jpg with a new cover.jpg) still forces the <img> to reload.
 */
export function usePackCover(packRoot: string | null) {
  return useQuery({
    queryKey: packQueryKeys.cover(packRoot),
    queryFn: async () => {
      if (!packRoot) return null;
      const path = await packService.getPackCover(packRoot);
      if (!path) return null;
      // Overwriting cover.png keeps the same URL, so bust the cache — but the
      // browser-mode transport already returns a query string ("/__media?path=…"),
      // and blindly appending "?v=" produced a second '?' that folded the buster
      // into the path parameter and 404'd every cover.
      const base = convertFileSrc(path);
      return `${base}${base.includes('?') ? '&' : '?'}v=${Date.now()}`;
    },
    enabled: Boolean(packRoot),
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}
