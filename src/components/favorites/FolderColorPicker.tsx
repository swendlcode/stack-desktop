import { PALETTE } from '../../utils/colorUtils';

interface FolderColorPickerProps {
  color: string;
  onChange: (color: string) => void;
}

/** Preset palette + a native color input so the user can pick literally any color. */
export function FolderColorPicker({ color, onChange }: FolderColorPickerProps) {
  const isCustom = !PALETTE.includes(color);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PALETTE.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={`h-6 w-6 rounded-full transition-transform hover:scale-110 ${
            color === c ? 'ring-2 ring-stack-white ring-offset-2 ring-offset-stack-black' : ''
          }`}
          style={{ backgroundColor: c }}
          aria-label={`Set color ${c}`}
        />
      ))}
      <label
        className={`relative flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-gray-600 bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] transition-transform hover:scale-110 ${
          isCustom ? 'ring-2 ring-stack-white ring-offset-2 ring-offset-stack-black' : ''
        }`}
        title="Custom color"
      >
        <input
          type="color"
          value={color}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label="Choose a custom color"
        />
      </label>
    </div>
  );
}
