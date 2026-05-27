import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePlayerStore } from '../../stores/playerStore';
import { settingsService } from '../../services/settingsService';
import { VolumeHigh, VolumeLow, VolumeMute } from '../ui/icons';
import { Slider } from '../ui/Slider';
import type { Settings } from '../../types';

export function VolumeControl() {
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const qc = useQueryClient();

  // Debounce the settings save so we don't hammer the backend while dragging
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback((v: number) => {
    setVolume(v);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const cached = qc.getQueryData<Settings>(['settings']);
      const save = (current: Settings) => {
        const updated = { ...current, defaultVolume: v };
        settingsService.updateSettings(updated)
          .then((result) => qc.setQueryData(['settings'], result))
          .catch(() => {});
      };
      if (cached) {
        save(cached);
      } else {
        settingsService.getSettings().then(save).catch(() => {});
      }
    }, 600);
  }, [setVolume, qc]);

  const Icon = volume === 0 ? VolumeMute : volume < 0.5 ? VolumeLow : VolumeHigh;

  return (
    <div className="flex h-8 items-center gap-2">
      <button
        onClick={() => handleChange(volume === 0 ? 0.9 : 0)}
        className="flex h-8 w-8 items-center justify-center text-gray-400 transition-colors hover:text-stack-white"
        aria-label="Toggle mute"
        title={volume === 0 ? 'Unmute' : 'Mute'}
      >
        <Icon size={18} color="currentColor" variant="Linear" />
      </button>
      <div className="flex h-8 w-24 items-center">
        <Slider value={volume} min={0} max={1} step={0.01} onChange={handleChange} />
      </div>
    </div>
  );
}
