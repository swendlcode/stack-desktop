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
  // Web access
  /** Serve the same UI over HTTP while the desktop app runs. */
  webAccessEnabled: boolean;
  /** Bind 0.0.0.0 instead of 127.0.0.1. Forces token auth on. */
  webAccessLan: boolean;
  webAccessPort: number;
}

/** Live state of the embedded HTTP server, plus ready-to-open URLs. */
export interface WebAccessInfo {
  enabled: boolean;
  lan: boolean;
  port: number;
  /** Port actually bound right now; null when the bind failed. */
  boundPort: number | null;
  running: boolean;
  /** Required on every request while `lan` is on. */
  token: string;
  localUrl: string;
  lanUrl: string | null;
  lanIp: string | null;
  /** Inline SVG QR code for lanUrl — scan it to open Stack on a phone. */
  lanQrSvg: string | null;
}
