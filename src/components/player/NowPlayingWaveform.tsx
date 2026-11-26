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
  // `play()` resets the store's duration to 0 and it is only refilled once
  // playback reports one, which the backend does over IPC a tick later rather
  // than synchronously from a decoded buffer. For that window `onSeek` below
  // went undefined and the waveform was not clickable at all. The indexer
  // already knows how long the file is, so use that until playback says
  // otherwise — the two agree, and one of them is available immediately.
  const duration = usePlayerStore((s) =>
    s.duration > 0 ? s.duration : (s.currentAsset?.durationMs ?? 0) / 1000,
  );
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
