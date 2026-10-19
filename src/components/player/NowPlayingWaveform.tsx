import { usePlayerStore } from "../../stores/playerStore";
import { WaveformViewer } from "../asset/WaveformViewer";

interface NowPlayingWaveformProps {
  assetId: string;
}

/**
 * The playing sample's waveform, filling the gap the bar leaves between the
 * file name and the key/tempo readout.
 *
 * It exists for the compact list: with row waveforms turned off there is
 * nowhere else to see the shape of what is playing or where the playhead sits.
 *
 * Subscribes to the playhead itself rather than taking it as a prop, for the
 * same reason `PlayerProgress` does — it redraws 20x a second and the artwork,
 * metadata and volume controls alongside it have no reason to re-render.
 */
export function NowPlayingWaveform({ assetId }: NowPlayingWaveformProps) {
  const progress = usePlayerStore((s) =>
    s.duration > 0 ? Math.min(1, Math.max(0, s.currentTime / s.duration)) : 0,
  );
  const duration = usePlayerStore((s) => s.duration);
  const seekTo = usePlayerStore((s) => s.seekTo);

  return (
    <WaveformViewer
      assetId={assetId}
      progress={progress}
      height={34}
      onSeek={
        seekTo && duration > 0
          ? (fraction) => seekTo(fraction * duration)
          : undefined
      }
    />
  );
}
