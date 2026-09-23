import { useEffect, useRef } from 'react';
import type { MidiNote } from '../../types';
import { useThemeEpoch } from '../../hooks/useThemeEpoch';

/** Reads a themed CSS variable off the document root. */
function cssVar(name: string, fallback: string) {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * `--stack-fire` is stored as a bare "R G B" triplet so Tailwind can apply an
 * alpha channel. Canvas needs real numbers: an unparsable fillStyle is
 * silently ignored, which would paint every note the previous colour.
 */
function parseTriplet(value: string): [number, number, number] {
  const parts = value.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  return parts.length >= 3 ? [parts[0], parts[1], parts[2]] : [242, 97, 63];
}

interface MidiViewerProps {
  notes: MidiNote[];
  height?: number;
  className?: string;
}

export function MidiViewer({ notes, height = 60, className = '' }: MidiViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Canvas pixels don't inherit CSS, so repaint when the theme changes.
  const themeKey = useThemeEpoch();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth * dpr;
    const h = canvas.clientHeight * dpr;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    ctx.clearRect(0, 0, w, h);

    // `--stack-fire` is an "R G B" triplet so it can take an alpha channel,
    // and it changes with the user's accent colour.
    const [ar, ag, ab] = parseTriplet(cssVar('--stack-fire', '242 97 63'));
    const muted = cssVar('--color-border', '#333');

    if (notes.length === 0) {
      ctx.fillStyle = muted;
      ctx.fillRect(0, h / 2 - 1, w, 2);
      return;
    }

    let maxTick = 0;
    let minPitch = 127;
    let maxPitch = 0;
    for (const n of notes) {
      const end = n.startTick + n.durationTicks;
      if (end > maxTick) maxTick = end;
      if (n.pitch < minPitch) minPitch = n.pitch;
      if (n.pitch > maxPitch) maxPitch = n.pitch;
    }
    const pitchSpan = Math.max(1, maxPitch - minPitch + 1);
    const rowHeight = h / pitchSpan;

    for (const n of notes) {
      const x = (n.startTick / maxTick) * w;
      const noteW = Math.max(2, (n.durationTicks / maxTick) * w);
      const y = h - (n.pitch - minPitch + 1) * rowHeight;
      const intensity = 0.3 + (n.velocity / 127) * 0.7;
      ctx.fillStyle = `rgba(${ar}, ${ag}, ${ab}, ${intensity})`;
      ctx.fillRect(x, y, noteW, Math.max(2, rowHeight - 1));
    }
  }, [notes, themeKey]);

  return <canvas ref={canvasRef} className={`w-full ${className}`} style={{ height }} />;
}
