import { useQuery } from '@tanstack/react-query';
import { convertFileSrc } from '@tauri-apps/api/core';
import { packService } from '../services/packService';
import { packQueryKeys } from './usePacks';

/**
 * The cover is read as bytes and handed to `<img>` as an object URL.
 *
 * It used to be handed the `asset://` URL straight from `convertFileSrc`, and
 * in the desktop app that never drew: the row showed the fallback music square
 * while the *same* pack, in the same build, served over web access showed the
 * artwork. Same backend, same file on disk — the only difference was the URL
 * the element was given.
 *
 * This is the lesson the `<audio>` element already taught, one layer along:
 * `fetch` can read an `asset://` URL, a WebKit resource loader cannot be
 * relied on to. Every other reader in this app — the decoder, the editor, the
 * cover upload's own drop preview — already fetches the bytes and hands over a
 * blob, and all of them work. This was the one place left putting a custom
 * scheme into the DOM, and the one place with a broken image.
 *
 * It also drops the `?v=` cache buster, which only ever existed to make a
 * replaced `cover.png` reload under an unchanged path: `cache: 'reload'` says
 * the same thing to the fetch, and a query string on a custom scheme is a
 * second thing that has to work for a thumbnail to appear.
 */

// Object URLs live until they are revoked, so they are kept in one small LRU
// rather than leaked per render. A library has a handful of packs with
// artwork, not thousands; 64 is far more than are ever on screen and bounds
// the memory either way.
const MAX_CACHED = 64;
const urlByPath = new Map<string, string>();

function objectUrlFor(path: string, blob: Blob): string {
  const existing = urlByPath.get(path);
  if (existing) {
    // Re-fetched because the artwork changed — the old URL now points at the
    // previous image and nothing should be holding it.
    URL.revokeObjectURL(existing);
    urlByPath.delete(path);
  }
  const url = URL.createObjectURL(blob);
  urlByPath.set(path, url);
  while (urlByPath.size > MAX_CACHED) {
    const oldest = urlByPath.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const stale = urlByPath.get(oldest);
    if (stale) URL.revokeObjectURL(stale);
    urlByPath.delete(oldest);
  }
  return url;
}

/**
 * `cache: 'reload'` is what replaces the old `?v=` buster, so a cover
 * overwritten at the same path is re-read rather than served from WebKit's
 * cache. It is also the only part of this call that is not the exact shape
 * already proven to work against `asset://` elsewhere in the app, so a
 * failure falls back to the plain fetch: a cover that might be one version
 * stale beats no cover at all, which is the bug this file exists to fix.
 */
async function readBytes(url: string): Promise<Blob> {
  for (const init of [{ cache: 'reload' as RequestCache }, undefined]) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.blob();
    } catch (err) {
      if (init === undefined) throw err;
    }
  }
  throw new Error('unreachable');
}

/**
 * Resolves the cover art for a pack root to a URL usable in `<img src>`,
 * or null when the pack has no artwork.
 */
export function usePackCover(packRoot: string | null) {
  return useQuery({
    queryKey: packQueryKeys.cover(packRoot),
    queryFn: async () => {
      if (!packRoot) return null;
      const path = await packService.getPackCover(packRoot);
      if (!path) return null;
      try {
        return objectUrlFor(path, await readBytes(convertFileSrc(path)));
      } catch {
        // No artwork is a normal outcome; an unreadable file should look the
        // same rather than leaving a broken image in the row.
        return null;
      }
    },
    enabled: Boolean(packRoot),
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}
