import { useRef } from 'react';
import { useWaveformCanvas, useWaveformData } from '../../hooks/useWaveform';

interface WaveformViewerProps {
  assetId: string;
  progress?: number;
  className?: string;
  height?: number;
  preloaded?: number[] | null;
  /** Called with a 0–1 fraction when the user clicks to seek */
  onSeek?: (fraction: number) => void;
}

export function WaveformViewer({
  assetId,
  progress = 0,
  className = '',
  height = 40,
  preloaded,
  onSeek,
}: WaveformViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Only fetch from backend if no preloaded data. The mid-scroll deferral
  // lives inside the query function, so this component never subscribes to
  // scroll state and never re-renders because of it.
  const shouldFetch = !preloaded || preloaded.length === 0;
  const { data: fetched } = useWaveformData(shouldFetch ? assetId : null);
  const effective = shouldFetch ? fetched : preloaded;

  useWaveformCanvas(canvasRef, effective, progress, height);

  // There is deliberately no sizing effect here. The canvas is stretched by
  // CSS (`absolute inset-0 h-full w-full`) and measured by the shared
  // ResizeObserver in `useWaveformCanvas`, so a row can mount without forcing
  // a layout — which, multiplied by every row a fling passes, is the
  // difference between a smooth list and a stuttering one.

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSeek) return;
    // Seeking is the whole gesture — don't let the row's click handler fire too.
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(1, fraction)));
  };

  return (
    <div
      className={`relative w-full ${className}`}
      style={{ height }}
    >
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 h-full w-full ${onSeek ? 'cursor-pointer' : ''}`}
        onClick={handleClick}
        aria-label="Waveform"
      />
    </div>
  );
}
