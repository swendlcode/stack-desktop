import type { Asset } from './asset';
import type { ScanProgress, ReconcileReport } from './pack';

export type StackEvent =
  | { name: 'stack://asset-indexed'; payload: Asset }
  | { name: 'stack://scan-progress'; payload: ScanProgress }
  | { name: 'stack://asset-missing'; payload: { id: string; path: string } }
  | { name: 'stack://waveform-ready'; payload: { id: string; data: number[] } }
  | { name: 'stack://reconcile-complete'; payload: ReconcileReport };

export interface Settings {
  // Playback
  defaultVolume: number;
  autoPlayNext: boolean;
  // Library
  indexerConcurrency: number;
  analyzeAudioInBackground: boolean;
  watchForChanges: boolean;
  pageSize: number;
  // Appearance
  theme: 'dark' | 'light';
  /** Accent color as hex ("#F2613F"). null/undefined = base default. */
  accentColor?: string | null;
  showWaveform: boolean;
  showBpmBadge: boolean;
  showKeyBadge: boolean;
  showPlaygroundBadge: boolean;
  enablePlaygroundMode: boolean;
  // Application
  launchAtStartup: boolean;
  confirmFolderRemoval: boolean;
  // Browser
  stickyToolbar: boolean;
  compactList: boolean;
  showTimeBadge: boolean;
  showFolderColumn: boolean;
}
