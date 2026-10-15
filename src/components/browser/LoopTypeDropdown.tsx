import { Dropdown, DropdownDivider, DropdownActions } from '../ui/Dropdown';
import { useFilterStore } from '../../stores/filterStore';
import { useFacetCounts } from '../../hooks/useFacetCounts';

// A sample is one or the other, never both, so these behave as radios rather
// than the checkboxes used by the instrument and genre facets.
const OPTIONS = [
  { value: 'loop', label: 'Loops' },
  { value: 'oneshot', label: 'One-Shots' },
] as const;

export function LoopTypeDropdown() {
  // Reads `loopTypes`, not `subtypes`. The distinction used to share the
  // subtype column with kick/snare/riser, where a first-match-wins token scan
  // meant only 17% of a real library ever carried it (issue #11).
  const loopTypes = useFilterStore((s) => s.filters.loopTypes);
  const setFilters = useFilterStore((s) => s.setLoopTypes);
  const { data: facets } = useFacetCounts();

  const countFor = (value: string) =>
    facets?.loopTypes.find((f) => f.value === value)?.count ?? 0;

  const selected = OPTIONS.find((o) => loopTypes.includes(o.value))?.value ?? null;
  const isActive = selected !== null;
  const label = isActive
    ? (OPTIONS.find((o) => o.value === selected)?.label ?? 'One-Shots & Loops')
    : 'One-Shots & Loops';

  // Picking one clears the other; picking the selected one clears the filter.
  const pick = (value: string) => {
    setFilters(selected === value ? [] : [value]);
  };

  return (
    <Dropdown label={label} active={isActive} minWidth={230}>
      <div className="py-1">
        {OPTIONS.map((o) => {
          const active = selected === o.value;
          const count = countFor(o.value);
          return (
            <button
              key={o.value}
              onClick={() => pick(o.value)}
              className={`flex w-full items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                active ? 'text-stack-fire' : 'text-gray-300 hover:bg-gray-800 hover:text-stack-white'
              }`}
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
                  active ? 'border-stack-fire' : 'border-gray-600'
                }`}
              >
                {active && <span className="h-2 w-2 rounded-full bg-stack-fire" />}
              </span>
              <span className="flex-1 text-left">{o.label}</span>
              <span
                className={`mono text-xs tabular-nums ${active ? 'text-stack-fire/70' : 'text-gray-600'}`}
              >
                {count.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>

      {isActive && (
        <>
          <DropdownDivider />
          <DropdownActions>
            <button
              onClick={() => setFilters([])}
              className="rounded-lg px-3 py-1.5 text-sm text-gray-400 transition-colors hover:bg-gray-700 hover:text-stack-white"
            >
              Clear
            </button>
          </DropdownActions>
        </>
      )}
    </Dropdown>
  );
}
