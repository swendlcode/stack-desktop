interface DawIconProps {
  daw: string | null | undefined;
  size?: number;
  className?: string;
}

/**
 * A DAW's own mark, used to say which program a project opens in.
 *
 * Only two are drawn: FL Studio and Ableton Live account for every project
 * file a real library turns up, and they are the two whose marks the vendors
 * publish in a form that survives being 16px tall. Everything else keeps the
 * lettered badge — inventing a logo for Cubase would be worse than a tidy
 * "Cubase". These are the vendors' trademarks, shown to name their product.
 */

// Ableton's mark is four verticals and four horizontals, so it stays crisp at
// any size and takes the surrounding text colour.
function AbletonMark({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 45 21"
      width={size}
      height={(size * 21) / 45}
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M0 0h3v21H0zM6 0h3v21H6zM12 0h3v21h-3zM18 0h3v21h-3zM24 18h21v3H24zM24 12h21v3H24zM24 6h21v3H24zM24 0h21v3H24z" />
    </svg>
  );
}

// Image-Line publish the fruit only as a raster. It is small, and it is the
// one part of their logo that reads at icon size.
const FL_FRUIT =
  'data:image/png;base64,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';

export function DawIcon({ daw, size = 16, className }: DawIconProps) {
  if (daw === 'Ableton Live') {
    return <AbletonMark size={size} className={className} />;
  }
  if (daw === 'FL Studio') {
    return (
      <img
        src={FL_FRUIT}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        className={className}
        style={{ objectFit: 'contain' }}
      />
    );
  }
  return null;
}

/** Whether `daw` has a mark, so callers can fall back to the lettered badge. */
export function hasDawIcon(daw: string | null | undefined): boolean {
  return daw === 'Ableton Live' || daw === 'FL Studio';
}
