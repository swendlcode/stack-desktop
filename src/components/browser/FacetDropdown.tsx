import { useMemo, useState } from 'react';
import { Dropdown, DropdownDivider, DropdownActions } from '../ui/Dropdown';
import { Checkbox } from '../ui/Checkbox';
import { SearchNormal } from '../ui/icons';
import type { FacetCount } from '../../services/assetService';

interface FacetDropdownProps {
  /** Dropdown label when nothing is selected, e.g. "Instrument". */
  title: string;
  /** Plural noun for the multi-selection label, e.g. "instruments". */
  plural: string;
  options: FacetCount[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
  labels?: Record<string, string>;
  /** Show a filter box once the list is longer than this. */
  searchThreshold?: number;
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Multi-select facet list with counts — the shared shape behind the
 * Instrument and Genre filters.
 */
export function FacetDropdown({
  title,
  plural,
  options,
  selected,
  onToggle,
  onClear,
  labels = {},
  searchThreshold = 12,
}: FacetDropdownProps) {
  const [filter, setFilter] = useState('');

  // Keep a selected value visible even when the current filters drop it to
  // zero, otherwise it becomes impossible to untick.
  const live = useMemo(
    () => options.filter((f) => f.count > 0 || selected.includes(f.value)),
    [options, selected],
  );

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return live;
    return live.filter(
      (f) => f.value.toLowerCase().includes(q) || (labels[f.value] ?? '').toLowerCase().includes(q),
    );
  }, [live, filter, labels]);

  const isActive = selected.length > 0;
  const label = isActive
    ? selected.length === 1
      ? (labels[selected[0]] ?? titleCase(selected[0]))
      : `${selected.length} ${plural}`
    : title;

  return (
    <Dropdown label={label} active={isActive} minWidth={260}>
      {live.length > searchThreshold && (
        <div className="border-b border-gray-700/70 p-2">
          <div className="flex h-8 items-center gap-2 rounded-md border border-gray-700 bg-gray-900 px-2.5">
            <SearchNormal size={13} color="var(--color-text-muted)" variant="Linear" />
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${plural}…`}
              className="w-full bg-transparent text-xs text-stack-white outline-none placeholder:text-gray-600"
            />
          </div>
        </div>
      )}

      <div className="max-h-72 overflow-y-auto py-1">
        {shown.length === 0 && (
          <p className="px-4 py-3 text-sm text-gray-500">
            {live.length === 0 ? `No ${plural} detected` : 'No matches'}
          </p>
        )}
        {shown.map((f) => {
          const active = selected.includes(f.value);
          return (
            <label
              key={f.value}
              className={`flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-sm transition-colors ${
                active ? 'text-stack-fire' : 'text-gray-300 hover:bg-gray-800 hover:text-stack-white'
              }`}
            >
              <Checkbox
                checked={active}
                onChange={() => onToggle(f.value)}
                aria-label={labels[f.value] ?? f.value}
              />
              <span className="flex-1 truncate text-left">
                {labels[f.value] ?? titleCase(f.value)}
              </span>
              <span
                className={`mono text-xs tabular-nums ${active ? 'text-stack-fire/70' : 'text-gray-600'}`}
              >
                {f.count.toLocaleString()}
              </span>
            </label>
          );
        })}
      </div>

      {isActive && (
        <>
          <DropdownDivider />
          <DropdownActions>
            <button
              onClick={onClear}
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
