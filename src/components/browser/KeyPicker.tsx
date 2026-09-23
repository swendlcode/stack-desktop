import { useState } from 'react';
import { Dropdown, DropdownDivider, DropdownActions } from '../ui/Dropdown';
import { useFilterStore } from '../../stores/filterStore';
import type { KeyScale } from '../../types';

// Accidentals are laid out as they sit on a keyboard — the two-black-key
// group, then the three-key group — so the grid reads like piano keys.
const FLAT_ACCIDENTALS = [
  ['Db', 'Eb'],
  ['Gb', 'Ab', 'Bb'],
];
const SHARP_ACCIDENTALS = [
  ['C#', 'D#'],
  ['F#', 'G#', 'A#'],
];
const NATURALS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SCALES: Array<{ value: KeyScale; label: string }> = [
  { value: 'major', label: 'Major' },
  { value: 'minor', label: 'Minor' },
];

/** Accidentals are stored in whichever spelling a pack used; the backend
 *  matches both, so the tabs are purely how you prefer to read them. */
function sameNote(a: string, b: string) {
  const pairs: Record<string, string> = {
    'C#': 'Db', Db: 'C#', 'D#': 'Eb', Eb: 'D#',
    'F#': 'Gb', Gb: 'F#', 'G#': 'Ab', Ab: 'G#',
    'A#': 'Bb', Bb: 'A#',
  };
  return a === b || pairs[a] === b;
}

function KeyButton({
  note,
  selected,
  onClick,
}: {
  note: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`mono h-9 min-w-[44px] rounded-lg border px-2 text-sm font-medium transition-colors ${
        selected
          ? 'border-stack-fire bg-stack-fire text-stack-black'
          : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-500 hover:text-stack-white'
      }`}
    >
      {note}
    </button>
  );
}

export function KeyPicker() {
  const keys = useFilterStore((s) => s.filters.keys);
  const scales = useFilterStore((s) => s.filters.scales);
  const toggleKey = useFilterStore((s) => s.toggleKey);
  const toggleScale = useFilterStore((s) => s.toggleScale);
  const clearKeys = useFilterStore((s) => s.clearKeys);
  const clearScales = useFilterStore((s) => s.clearScales);

  const [spelling, setSpelling] = useState<'flat' | 'sharp'>('flat');
  const accidentals = spelling === 'flat' ? FLAT_ACCIDENTALS : SHARP_ACCIDENTALS;

  const isSelected = (note: string) => keys.some((k) => sameNote(k, note));
  const isActive = keys.length > 0 || scales.length > 0;
  const label = isActive
    ? keys.length === 1 && scales.length === 1
      ? `${keys[0]} ${scales[0]}`
      : keys.length === 1
        ? keys[0]
        : keys.length > 1
          ? `${keys.length} keys`
          : scales.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(', ')
    : 'Key';

  return (
    <Dropdown label={label} active={isActive} minWidth={300}>
      {/* Spelling tabs */}
      <div className="flex border-b border-gray-700/70">
        {(['flat', 'sharp'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setSpelling(mode)}
            className={`relative flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
              spelling === mode ? 'text-stack-white' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {mode === 'flat' ? 'Flat keys' : 'Sharp keys'}
            {spelling === mode && (
              <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-stack-fire" />
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3 p-3">
        {/* Accidentals, grouped like the black keys */}
        <div className="flex justify-center gap-4">
          {accidentals.map((group, i) => (
            <div key={i} className="flex gap-1.5">
              {group.map((note) => (
                <KeyButton
                  key={note}
                  note={note}
                  selected={isSelected(note)}
                  onClick={() => toggleKey(note)}
                />
              ))}
            </div>
          ))}
        </div>

        {/* Naturals */}
        <div className="flex justify-center gap-1.5">
          {NATURALS.map((note) => (
            <KeyButton
              key={note}
              note={note}
              selected={isSelected(note)}
              onClick={() => toggleKey(note)}
            />
          ))}
        </div>

        {/* Scale */}
        <div className="flex gap-2">
          {SCALES.map((s) => (
            <button
              key={s.value}
              onClick={() => toggleScale(s.value)}
              className={`h-9 flex-1 rounded-lg border text-sm font-medium transition-colors ${
                scales.includes(s.value)
                  ? 'border-stack-fire bg-stack-fire/15 text-stack-fire'
                  : 'border-gray-700 text-gray-300 hover:border-gray-500 hover:text-stack-white'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {isActive && (
        <>
          <DropdownDivider />
          <DropdownActions>
            <button
              onClick={() => {
                clearKeys();
                clearScales();
              }}
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
