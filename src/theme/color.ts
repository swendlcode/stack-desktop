/**
 * Color helpers for the theme system.
 *
 * The CSS palette stores colors as space-separated RGB triplets ("242 97 63")
 * so Tailwind's `<alpha-value>` placeholder can compose opacity modifiers
 * (see src/index.css). These helpers convert user-chosen hex accents into that
 * format and derive the lighter hover shade.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse "#RGB" / "#RRGGBB" (with or without leading #) into channels. Returns null on garbage. */
export function parseHex(hex: string): Rgb | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** "#F2613F" → "242 97 63" (the var triplet format). Falls back to the input on parse failure. */
export function hexToTriplet(hex: string): string | null {
  const rgb = parseHex(hex);
  return rgb ? `${rgb.r} ${rgb.g} ${rgb.b}` : null;
}

/** Lighten a hex toward white by `pct` (0–1). Used to derive the accent-hover shade. */
export function lighten(hex: string, pct: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const mix = (c: number) => Math.round(c + (255 - c) * pct);
  const toHex = (c: number) => c.toString(16).padStart(2, '0');
  return `#${toHex(mix(rgb.r))}${toHex(mix(rgb.g))}${toHex(mix(rgb.b))}`;
}

/** Darken a hex toward black by `pct` (0–1). Used to derive the editor cue shade. */
export function darken(hex: string, pct: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const mix = (c: number) => Math.round(c * (1 - pct));
  const toHex = (c: number) => c.toString(16).padStart(2, '0');
  return `#${toHex(mix(rgb.r))}${toHex(mix(rgb.g))}${toHex(mix(rgb.b))}`;
}

/** "242 97 63" (the var triplet format) → "#f2613f". Returns null on garbage. */
export function tripletToHex(triplet: string): string | null {
  const parts = triplet.trim().split(/[\s,]+/).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const toHex = (c: number) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0');
  return `#${toHex(parts[0])}${toHex(parts[1])}${toHex(parts[2])}`;
}
