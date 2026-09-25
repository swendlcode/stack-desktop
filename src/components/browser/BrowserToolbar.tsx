import { useState, useMemo } from 'react';
import {
  Dropdown,
  DropdownSection,
  DropdownActions,
} from '../ui/Dropdown';
import { Slider } from '../ui/Slider';
import {
  Heart,
  HeartAdd,
  CloseCircle,
} from '../ui/icons';
import { useSearch } from '../../hooks/useSearch';
import { SmartSearch } from './SmartSearch';
import { FacetDropdown } from './FacetDropdown';
import { KeyPicker } from './KeyPicker';
import { LoopTypeDropdown } from './LoopTypeDropdown';
import { useFilterStore } from '../../stores/filterStore';
import { useFacetCounts } from '../../hooks/useFacetCounts';
import type { AssetType } from '../../types';

// ─── constants ────────────────────────────────────────────────────────────────

const TYPES: Array<{ value: AssetType | 'all'; label: string }> = [
  { value: 'all',     label: 'All'       },
  { value: 'sample',  label: 'Samples'  },
  { value: 'midi',    label: 'MIDI'     },
  { value: 'preset',  label: 'Presets'  },
  { value: 'project', label: 'Projects' },
];

// Pretty labels for known instrument values
const INSTRUMENT_LABELS: Record<string, string> = {
  drum: 'Drums', bass: 'Bass', synth: 'Synth', lead: 'Lead',
  pad: 'Pad', pluck: 'Pluck', chord: 'Chord', arp: 'Arp',
  keys: 'Keys', piano: 'Piano', guitar: 'Guitar', strings: 'Strings',
  brass: 'Brass', wind: 'Wind', vocal: 'Vocal', fx: 'FX',
};


const BPM_MIN = 40;
const BPM_MAX = 220;

// ─── shared primitives ────────────────────────────────────────────────────────

function NumInput({
  value,
  placeholder,
  onChange,
}: {
  value: number | null;
  placeholder: string;
  onChange: (v: number | null) => void;
}) {
  return (
    <input
      type="number"
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) =>
        onChange(e.target.value === '' ? null : Number(e.target.value))
      }
      className="mono h-9 w-24 rounded-lg border border-gray-600 bg-gray-800 px-3 text-sm text-stack-white outline-none focus:border-stack-fire"
    />
  );
}

// ─── BPM dropdown ─────────────────────────────────────────────────────────────

function BpmDropdown() {
  const filters = useFilterStore((s) => s.filters);
  const setBpmRange = useFilterStore((s) => s.setBpmRange);

  const [mode, setMode] = useState<'range' | 'exact'>('range');
  const [draftMin, setDraftMin] = useState<number | null>(filters.bpmMin);
  const [draftMax, setDraftMax] = useState<number | null>(filters.bpmMax);
  const [draftExact, setDraftExact] = useState<number | null>(filters.bpmMin);

  const isActive = filters.bpmMin != null || filters.bpmMax != null;

  const updateNearestHandle = (clientX: number, rect: DOMRect) => {
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const raw = BPM_MIN + ratio * (BPM_MAX - BPM_MIN);
    const next = Math.round(raw);
    const minNow = draftMin ?? BPM_MIN;
    const maxNow = draftMax ?? BPM_MAX;
    const useMin = Math.abs(next - minNow) <= Math.abs(next - maxNow);
    if (useMin) {
      const bounded = Math.min(next, maxNow);
      setDraftMin(bounded);
    } else {
      const bounded = Math.max(next, minNow);
      setDraftMax(bounded);
    }
  };

  const save = () => {
    if (mode === 'exact' && draftExact != null) {
      setBpmRange(draftExact, draftExact);
    } else {
      setBpmRange(draftMin, draftMax);
    }
  };

  const clear = () => {
    setDraftMin(null);
    setDraftMax(null);
    setDraftExact(null);
    setBpmRange(null, null);
  };

  const label = isActive
    ? filters.bpmMin === filters.bpmMax && filters.bpmMin != null
      ? `${filters.bpmMin} BPM`
      : `${filters.bpmMin ?? '?'}–${filters.bpmMax ?? '?'} BPM`
    : 'BPM';

  return (
    <Dropdown label={label} active={isActive} minWidth={300}>
      {/* Mode tabs */}
      <div className="flex border-b border-gray-700">
        {(['range', 'exact'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 py-2.5 text-sm font-normal capitalize transition-colors ${
              mode === m
                ? 'border-b-2 border-stack-fire text-stack-fire'
                : 'text-gray-400 hover:text-stack-white'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === 'range' ? (
        <DropdownSection>
          <div className="mb-5">
            <div className="mb-3 flex items-center justify-between">
              <span className="mono text-sm font-medium text-stack-white">
                {draftMin ?? BPM_MIN}
              </span>
              <span className="text-xs text-gray-500">BPM range</span>
              <span className="mono text-sm font-medium text-stack-white">
                {draftMax ?? BPM_MAX}
              </span>
            </div>
            {/* Track */}
            <div
              className="relative h-6 flex items-center"
              onMouseDown={(e) => {
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                updateNearestHandle(e.clientX, rect);
              }}
            >
              <div className="absolute z-0 h-1.5 w-full rounded-full bg-gray-700" />
              <div
                className="absolute z-10 h-1.5 rounded-full bg-stack-fire"
                style={{
                  left: `${(((draftMin ?? BPM_MIN) - BPM_MIN) / (BPM_MAX - BPM_MIN)) * 100}%`,
                  right: `${
                    100 -
                    (((draftMax ?? BPM_MAX) - BPM_MIN) / (BPM_MAX - BPM_MIN)) * 100
                  }%`,
                }}
              />
              <input
                type="range"
                min={BPM_MIN}
                max={BPM_MAX}
                step={1}
                value={draftMin ?? BPM_MIN}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setDraftMin(v);
                  if (draftMax != null && v > draftMax) setDraftMax(v);
                }}
                className="stack-slider stack-slider-overlay absolute z-30 w-full bg-transparent"
              />
              <input
                type="range"
                min={BPM_MIN}
                max={BPM_MAX}
                step={1}
                value={draftMax ?? BPM_MAX}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setDraftMax(v);
                  if (draftMin != null && v < draftMin) setDraftMin(v);
                }}
                className="stack-slider stack-slider-overlay absolute z-20 w-full bg-transparent"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <NumInput value={draftMin} placeholder="Min" onChange={setDraftMin} />
            <span className="text-gray-500">–</span>
            <NumInput value={draftMax} placeholder="Max" onChange={setDraftMax} />
          </div>
        </DropdownSection>
      ) : (
        <DropdownSection>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <NumInput
                value={draftExact}
                placeholder="e.g. 128"
                onChange={setDraftExact}
              />
              <span className="text-sm text-gray-500">BPM</span>
            </div>
            <Slider
              value={draftExact ?? 120}
              min={BPM_MIN}
              max={BPM_MAX}
              step={1}
              onChange={setDraftExact}
            />
          </div>
        </DropdownSection>
      )}

      <DropdownActions>
        <button
          onClick={clear}
          className="rounded-lg px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-700 hover:text-stack-white transition-colors"
        >
          Clear
        </button>
        <button
          onClick={save}
          className="rounded-lg bg-stack-fire px-4 py-1.5 text-sm font-medium text-stack-black hover:opacity-90 transition-opacity"
        >
          Apply
        </button>
      </DropdownActions>
    </Dropdown>
  );
}

// ─── Instrument + Genre — multi-select facet lists ───────────────────────────

function InstrumentDropdown() {
  const instruments = useFilterStore((s) => s.filters.instruments);
  const toggleInstrument = useFilterStore((s) => s.toggleInstrument);
  const clearInstruments = useFilterStore((s) => s.clearInstruments);
  const { data: facets } = useFacetCounts();

  return (
    <FacetDropdown
      title="Instrument"
      plural="instruments"
      options={facets?.instruments ?? []}
      selected={instruments}
      onToggle={toggleInstrument}
      onClear={clearInstruments}
      labels={INSTRUMENT_LABELS}
    />
  );
}

function GenreDropdown() {
  const genres = useFilterStore((s) => s.filters.genres);
  const toggleGenre = useFilterStore((s) => s.toggleGenre);
  const clearGenres = useFilterStore((s) => s.clearGenres);
  const { data: facets } = useFacetCounts();

  return (
    <FacetDropdown
      title="Genre"
      plural="genres"
      options={facets?.genres ?? []}
      selected={genres}
      onToggle={toggleGenre}
      onClear={clearGenres}
    />
  );
}

// ─── Main toolbar ──────────────────────────────────────────────────────────────

export function BrowserToolbar({
  resultCount: _resultCount,
  showFavoritesFilter = true,
  showPathChip = true,
  showTypeTabs = true,
  showKeyFilter = true,
  showBpmFilter = true,
  searchPlaceholder = 'Search samples, packs, instruments…',
  showSearch = false,
  showLoopTypeFilter = true,
}: {
  resultCount: number;
  showFavoritesFilter?: boolean;
  showPathChip?: boolean;
  showTypeTabs?: boolean;
  showKeyFilter?: boolean;
  showBpmFilter?: boolean;
  searchPlaceholder?: string;
  /** The overlay window has no title bar, so it needs its own search box. */
  showSearch?: boolean;
  /** One-Shots vs Loops — only meaningful for audio samples. */
  showLoopTypeFilter?: boolean;
}) {
  const [draft, setDraft] = useSearch();
  const filters = useFilterStore((s) => s.filters);
  const setTypes = useFilterStore((s) => s.setTypes);
  const toggleInstrument = useFilterStore((s) => s.toggleInstrument);
  const toggleFavoritesOnly = useFilterStore((s) => s.toggleFavoritesOnly);
  const setPathPrefix = useFilterStore((s) => s.setPathPrefix);
  const resetFilters = useFilterStore((s) => s.resetFilters);
  const { data: facets } = useFacetCounts();

  const liveCategories = useMemo(
    () => (facets?.instruments ?? []).filter(
      (f) => f.count > 0 || filters.instruments.includes(f.value)
    ),
    [facets?.instruments, filters.instruments],
  );

  const pathLabel = filters.pathPrefix
    ? filters.pathPrefix.split(/[/\\]/).filter(Boolean).slice(-2).join(' / ')
    : null;

  const activeFilterCount =
    filters.types.length +
    filters.instruments.length +
    filters.keys.length +
    filters.scales.length +
    (filters.bpmMin != null || filters.bpmMax != null ? 1 : 0) +
    (filters.favoritesOnly ? 1 : 0);

  return (
    <div className="shrink-0 border-b border-gray-700 bg-gray-900">

      {/* ── Row 1: Type tabs ── */}
      {showTypeTabs && (
        <div className="scrollbar-none flex items-center gap-0.5 overflow-x-auto border-b border-gray-700/60 px-3 pb-0 pt-2 sm:px-6">
          {TYPES.map((t) => {
            const active =
              t.value === 'all'
                ? filters.types.length === 0
                : filters.types.length === 1 && filters.types[0] === t.value;
            return (
              <button
                key={t.value}
                onClick={() => setTypes(t.value === 'all' ? [] : [t.value])}
                className={`relative shrink-0 px-3 pb-2.5 pt-2 text-sm font-normal transition-colors sm:px-4 sm:pt-1.5 ${
                  active ? 'text-stack-fire' : 'text-gray-400 hover:text-stack-white'
                }`}
              >
                {t.label}
                {active && (
                  <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-t-full bg-stack-fire" />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Row 2: Search + filter dropdowns ──
          Below `md` the row scrolls sideways instead of wrapping: a wrapped
          filter row eats a third of a phone screen before a single result is
          visible, and `overflow-x-auto` here (rather than on the page) is
          what keeps the body from scrolling horizontally. Every child is
          pinned `shrink-0` so labels don't get squeezed into two lines. */}
      <div className="flex items-center gap-2 px-3 py-2.5 max-md:overflow-x-auto max-md:scrollbar-none sm:gap-2.5 sm:px-6">
        {showSearch && (
          <>
            <SmartSearch
              className="w-64 shrink-0 sm:w-80"
              placeholder={searchPlaceholder}
              value={draft}
              onChange={setDraft}
            />
            <div className="h-5 w-px shrink-0 bg-gray-700" />
          </>
        )}

        <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">
          <InstrumentDropdown />
          <GenreDropdown />
          {showLoopTypeFilter && <LoopTypeDropdown />}
          {showKeyFilter && <KeyPicker />}
          {showBpmFilter && <BpmDropdown />}
        </div>

        <div className="h-5 w-px shrink-0 bg-gray-700" />

        {showFavoritesFilter && (
          <button
            onClick={toggleFavoritesOnly}
            className={`flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-3.5 md:h-9 text-sm font-normal transition-colors ${
              filters.favoritesOnly
                ? 'border-stack-fire bg-stack-fire/10 text-stack-fire'
                : 'border-gray-600 text-gray-300 hover:border-gray-500 hover:bg-gray-800 hover:text-stack-white'
            }`}
          >
            {filters.favoritesOnly ? (
              <HeartAdd size={14} variant="Bulk" color="currentColor" />
            ) : (
              <Heart size={14} variant="Linear" color="currentColor" />
            )}
            Favorites
          </button>
        )}


        {showPathChip && pathLabel && (
          <button
            onClick={() => setPathPrefix(null)}
            className="flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-stack-fire md:h-9 bg-stack-fire/10 px-3.5 text-sm text-stack-fire"
            title={filters.pathPrefix ?? ''}
          >
            <CloseCircle size={13} variant="Linear" color="currentColor" />
            {pathLabel}
          </button>
        )}

        {(activeFilterCount > 0 || draft) && (
          <button
            onClick={() => {
              resetFilters();
              setDraft('');
            }}
            className="shrink-0 whitespace-nowrap px-1 text-sm text-gray-500 transition-colors hover:text-stack-white"
          >
            Clear all
          </button>
        )}

        <div className="hidden flex-1 md:block" />
      </div>

      {/* ── Row 3: Quick category strip — live from facet counts ── */}
      {liveCategories.length > 0 && (
        <div className="flex items-center gap-1 sm:gap-1.5 overflow-x-auto px-3 sm:px-6 pb-2.5 scrollbar-none">
          {liveCategories.map((f) => {
            const active = filters.instruments.includes(f.value);
            const displayLabel = INSTRUMENT_LABELS[f.value] ?? (f.value.charAt(0).toUpperCase() + f.value.slice(1));
            return (
              <button
                key={f.value}
                onClick={() => toggleInstrument(f.value)}
                className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-2.5 text-xs transition-colors sm:px-3 sm:py-1.5 sm:text-sm ${
                  active
                    ? 'bg-stack-fire text-stack-black font-medium'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-stack-white'
                }`}
              >
                {displayLabel}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
