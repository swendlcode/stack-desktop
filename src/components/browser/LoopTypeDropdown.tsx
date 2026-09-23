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
  const subtypes = useFilterStore((s) => s.filters.subtypes);
  const setFilters = useFilterStore((s) => s.setSubtypes);
  const { data: facets } = useFacetCounts();

  const countFor = (value: string) =>
    facets?.subtypes.find((f) => f.value === value)?.count ?? 0;

  const selected = OPTIONS.find((o) => subtypes.includes(o.value))?.value ?? null;
  const isActive = selected !== null;
  const label = isActive
    ? (OPTIONS.find((o) => o.value === selected)?.label ?? 'One-Shots & Loops')
    : 'One-Shots & Loops';

  // Picking one clears the other; picking the selected one clears the filter.
  const pick = (value: string) => {
    const others = subtypes.filter((s) => !OPTIONS.some((o) => o.value === s));
    setFilters(selected === value ? others : [...others, value]);
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
              onClick={() => setFilters(subtypes.filter((s) => !OPTIONS.some((o) => o.value === s)))}
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
