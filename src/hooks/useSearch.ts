import { useEffect, useRef, useState } from 'react';
import { useFilterStore } from '../stores/filterStore';

/**
 * Local input state debounced into the filter store query.
 *
 * The draft is the source of truth while you type — reading the store back as
 * a plain effect dependency caused an infinite loop (type → store updates →
 * effect re-runs → repeat). So the draft is pushed to the store on a timer,
 * and the store is adopted back only when something *else* changed it: a
 * suggestion chip, "clear search", a link. `lastPushed` is what distinguishes
 * the two — an echo of our own write is ignored, anyone else's is taken.
 */
export function useSearch(delayMs = 200) {
  const setQuery = useFilterStore((s) => s.setQuery);
  const storeQuery = useFilterStore((s) => s.filters.query);

  const [draft, setDraft] = useState(storeQuery);
  const draftRef = useRef(draft);
  const lastPushed = useRef(storeQuery);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (storeQuery !== lastPushed.current) {
      lastPushed.current = storeQuery;
      setDraft(storeQuery);
    }
  }, [storeQuery]);

  useEffect(() => {
    const t = setTimeout(() => {
      lastPushed.current = draftRef.current;
      setQuery(draftRef.current);
    }, delayMs);
    return () => clearTimeout(t);
    // Only re-run when the draft changes — not when the store query does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, delayMs]);

  return [draft, setDraft] as const;
}
