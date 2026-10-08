import { useFilterStore } from '../../stores/filterStore';
import { CloseCircle } from '../ui/icons';

/**
 * The heading above a set of search results.
 *
 * A search used to drop you into a list with nothing saying what you had
 * searched for — the query only lived in the box at the top of the window,
 * which scrolls out of mind. This states it, and gives one obvious way back
 * to the full library.
 */
export function SearchHero({ query }: { query: string }) {
  // Clearing the store is enough — `useSearch` adopts a query set from
  // outside, so the box at the top empties with it.
  const clear = () => useFilterStore.getState().setQuery('');

  return (
    <div className="flex items-start gap-3 border-b border-gray-700 px-4 pb-4 pt-5 sm:px-6">
      <h2 className="min-w-0 flex-1 truncate text-2xl font-bold text-stack-white" title={query}>
        Search results for “{query}”
      </h2>
      <button
        onClick={clear}
        title="Clear search"
        aria-label="Clear search"
        className="mt-1 shrink-0 rounded p-1 text-gray-500 transition-colors hover:bg-gray-800 hover:text-stack-white"
      >
        <CloseCircle size={16} variant="Linear" color="currentColor" />
      </button>
    </div>
  );
}
