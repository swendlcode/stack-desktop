import { useFilterStore } from '../../stores/filterStore';
import { useFacetCounts } from '../../hooks/useFacetCounts';
import { useSearchSuggestions } from '../../hooks/useSearchSuggestions';
import { useSearch } from '../../hooks/useSearch';

function Chip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:border-stack-fire hover:text-stack-white"
    >
      {label}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-widest text-gray-500">{title}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/**
 * Shown when a search returns nothing: the nearest real terms if the query
 * looks like a typo, then what the library actually contains so there is
 * always a way forward.
 */
export function NoResults({ noun }: { noun: string }) {
  const query = useFilterStore((s) => s.filters.query);
  const setQuery = useFilterStore((s) => s.setQuery);
  const resetFilters = useFilterStore((s) => s.resetFilters);
  const toggleInstrument = useFilterStore((s) => s.toggleInstrument);
  const toggleGenre = useFilterStore((s) => s.toggleGenre);
  const [, setDraft] = useSearch();
  const { data: suggestions } = useSearchSuggestions(query, Boolean(query));
  const { data: facets } = useFacetCounts();

  const search = (term: string) => {
    setDraft(term);
    setQuery(term);
  };

  const corrections = suggestions?.corrections ?? [];
  const popular = suggestions?.popular ?? [];
  const instruments = (facets?.instruments ?? []).filter((f) => f.count > 0).slice(0, 6);
  const genres = (facets?.genres ?? []).filter((f) => f.count > 0).slice(0, 6);

  if (!query) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-gray-500">
        <div className="text-lg font-semibold text-gray-400">No {noun} found</div>
        <div className="text-sm">Try clearing your filters, or add a folder in Settings.</div>
        <button
          onClick={resetFilters}
          className="mt-2 rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:border-stack-fire hover:text-stack-white"
        >
          Clear all filters
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="flex w-full max-w-lg flex-col gap-6">
        <div className="flex flex-col gap-1">
          <div className="text-lg font-semibold text-gray-300">
            No {noun} for “<span className="text-stack-white">{query}</span>”
          </div>
          {corrections.length > 0 ? (
            <div className="text-sm text-gray-500">
              Did you mean{' '}
              {corrections.map((c, i) => (
                <span key={c}>
                  {i > 0 && ', '}
                  <button
                    onClick={() => search(c)}
                    className="text-stack-fire underline-offset-2 hover:underline"
                  >
                    {c}
                  </button>
                </span>
              ))}
              ?
            </div>
          ) : (
            <div className="text-sm text-gray-500">
              Check the spelling, or start from what your library has.
            </div>
          )}
        </div>

        {popular.length > 0 && (
          <Section title="Popular searches">
            {popular.slice(0, 6).map((t) => (
              <Chip key={t} label={t} onClick={() => search(t)} />
            ))}
          </Section>
        )}

        {genres.length > 0 && (
          <Section title="Top genres">
            {genres.map((g) => (
              <Chip
                key={g.value}
                label={g.value}
                onClick={() => {
                  search('');
                  toggleGenre(g.value);
                }}
              />
            ))}
          </Section>
        )}

        {instruments.length > 0 && (
          <Section title="Top instruments">
            {instruments.map((f) => (
              <Chip
                key={f.value}
                label={f.value}
                onClick={() => {
                  search('');
                  toggleInstrument(f.value);
                }}
              />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}
