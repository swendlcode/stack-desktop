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

  /**
   * Seek on PRESS, for the same reason the row auditions on press — and
   * because doing it on release made one gesture into two sounds.
   *
   * The row around this canvas starts the sample from the top on
   * `pointerdown`. Seeking here on `click` meant the press went up to the row
   * and played from 0, and then the release played again from wherever the
   * pointer was: issue #15, "sound plays once on click and again on release".
   * The `stopPropagation` that used to sit here was on the click, which is far
   * too late — by then the press had already bubbled and been acted on.
   *
   * Claiming the press instead fixes it and makes the waveform behave like
   * every other control in the app. The row still gets its selection: the
   * press is not stopped, and `AssetRow` recognises a press on a waveform and
   * selects without auditioning.
   */
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onSeek || e.button !== 0) return;
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
        onPointerDown={handlePointerDown}
        aria-label="Waveform"
      />
    </div>
  );
}
