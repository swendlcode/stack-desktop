import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { libraryService } from '../services/libraryService';
import { settingsService } from '../services/settingsService';
import { audioEngine } from '../services/audioEngine';
import { usePlayerStore } from '../stores/playerStore';
import { Button } from '../components/ui/Button';
import {
  Trash,
  Refresh,
  VolumeHigh,
  VolumeLow,
  VolumeMute,
  ArrowDown2,
  HeartAdd,
} from '../components/ui/icons';

import { Slider } from '../components/ui/Slider';
import { ThemeSettings } from '../components/settings/ThemeSettings';
import { SettingRow, SettingSection, Toggle } from '../components/settings/primitives';
import { WebAccessSettings } from '../components/settings/WebAccessSettings';
import { PluginFolderSettings } from '../components/settings/PluginFolderSettings';
import { packQueryKeys } from '../hooks/usePacks';
import { assetQueryKeys } from '../hooks/useAssets';
import { libraryTreeKey } from '../hooks/useLibraryTree';
import type { Settings, WatchedFolder, FolderInfo } from '../types';
import { useUiStore } from '../stores/uiStore';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function Select({ value, options, onChange }: {
  value: string | number;
  options: Array<{ value: string | number; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative flex h-8 min-w-[128px] items-center">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mono h-8 w-full appearance-none rounded-md border border-gray-700 bg-gray-800 px-2.5 pr-7 text-xs text-stack-white outline-none transition-colors hover:border-gray-600 focus:border-stack-fire"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2 text-gray-400">
        <ArrowDown2 size={13} color="currentColor" variant="Linear" />
      </span>
    </div>
  );
}

function VolumeSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const Icon = value === 0 ? VolumeMute : value < 0.5 ? VolumeLow : VolumeHigh;
  return (
    <div className="flex h-8 items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center text-gray-400">
        <Icon size={18} color="currentColor" variant="Linear" />
      </span>
      <div className="flex h-8 w-24 items-center">
        <Slider value={value} min={0} max={1} step={0.05} onChange={onChange} />
      </div>
      <span className="mono w-8 text-right text-xs text-gray-400">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

// ─── Folder row ───────────────────────────────────────────────────────────────

/** Watched folders are listed flat, so the non-default kinds say what they are. */
function FolderKindBadge({ kind }: { kind: WatchedFolder['kind'] }) {
  if (kind !== 'splice' && kind !== 'project') return null;
  const label = kind === 'splice' ? 'Splice' : 'Project';
  const tone =
    kind === 'splice'
      ? 'border-stack-fire/50 bg-stack-fire/10 text-stack-fire'
      : 'border-gray-600 bg-gray-700 text-gray-300';
  return (
    <span
      className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}
    >
      {label}
    </span>
  );
}

/**
 * A name for the tile heading.
 *
 * Splice registers `<library>/sounds/packs`, so the last segment is "packs" for
 * every account — three tiles all reading the same word. Dropping that suffix
 * leaves the library folder, which is what distinguishes them.
 */
function folderLabel(folder: WatchedFolder): string {
  const parts = folder.path.split(/[/\\]/).filter(Boolean);
  if (
    folder.kind === 'splice' &&
    parts.length > 2 &&
    parts[parts.length - 1] === 'packs' &&
    parts[parts.length - 2] === 'sounds'
  ) {
    return parts[parts.length - 3]!;
  }
  return parts[parts.length - 1] ?? folder.path;
}

/**
 * One watched folder as a compact tile.
 *
 * These used to be full-width cards with a labelled Remove button, which meant
 * six folders filled the screen before the rest of Settings appeared. A Splice
 * import alone adds three. The folder name leads, the full path sits under it
 * for disambiguation, and the stats collapse to a single mono line.
 */
function FolderInfoRow({ folder, onRemove }: { folder: WatchedFolder; onRemove: () => void }) {
  const { data: info, isLoading } = useQuery<FolderInfo>({
    queryKey: ['folder-info', folder.path],
    queryFn: () => libraryService.getFolderInfo(folder.path),
    staleTime: 60_000,
  });

  const name = folderLabel(folder);
  // Removing cascade-deletes every asset and pack under the path, and the trash
  // is a small hover target in a dense grid — so it asks first.
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="group flex min-w-0 flex-col gap-1 rounded-md border border-gray-700 bg-gray-800 p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-stack-white" title={folder.path}>
          {name}
        </span>
        <FolderKindBadge kind={folder.kind} />
        {/* Hover-revealed on pointer devices, always visible on touch. */}
        <button
          onClick={() => setConfirming(true)}
          title="Remove folder"
          aria-label={`Remove ${name}`}
          className="shrink-0 rounded p-1 text-gray-500 opacity-100 transition-colors hover:bg-red-500/10 hover:text-red-400 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
        >
          <Trash size={14} variant="Linear" color="currentColor" />
        </button>
      </div>

      <p className="mono truncate text-[11px] text-gray-500" title={folder.path}>
        {folder.path}
      </p>

      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[11px] text-gray-400">Remove from Stack?</span>
          <button
            onClick={onRemove}
            className="rounded border border-red-500/40 px-2 py-0.5 text-[11px] text-red-300 transition-colors hover:bg-red-500/10"
          >
            Remove
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="rounded px-2 py-0.5 text-[11px] text-gray-400 transition-colors hover:text-stack-white"
          >
            Cancel
          </button>
        </div>
      ) : (
        <p className="mono text-[11px] text-gray-400">
          {isLoading
            ? 'Reading…'
            : info
              ? `${formatBytes(info.totalSizeBytes)} · ${info.fileCount.toLocaleString()} files · ${info.assetCount.toLocaleString()} indexed`
              : '—'}
        </p>
      )}
    </div>
  );
}

// ─── Audio output ────────────────────────────────────────────────────────────────
// Output device + sample-rate selection. Sample rate always works (rebuilds the
// AudioContext). Output-device routing depends on setSinkId, which WKWebView may
// not support — so that control is shown only when the runtime can actually use it.

const SAMPLE_RATE_OPTIONS = [
  { value: '', label: 'System default' },
  { value: '44100', label: '44.1 kHz' },
  { value: '48000', label: '48 kHz' },
  { value: '88200', label: '88.2 kHz' },
  { value: '96000', label: '96 kHz' },
];

function AudioOutputSettings() {
  const supportsOutput = audioEngine.supportsOutputSelection();
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [sinkId, setSinkId] = useState<string>(() => audioEngine.getPreferredSinkId() ?? '');
  const [sampleRate, setSampleRate] = useState<string>(
    () => String(audioEngine.getPreferredSampleRate() ?? '')
  );

  const [unlocking, setUnlocking] = useState(false);

  useEffect(() => {
    if (!supportsOutput) return;
    audioEngine.listOutputDevices().then(setDevices).catch(() => {});
  }, [supportsOutput]);

  const usableDevices = devices.filter((d) => d.deviceId && d.deviceId !== 'default');
  const deviceOptions = [
    { value: '', label: 'System default' },
    ...usableDevices.map((d, i) => ({ value: d.deviceId, label: d.label || `Output ${i + 1}` })),
  ];

  const labelsHidden = supportsOutput && devices.some((d) => d.deviceId && !d.label);
  const needsUnlock = supportsOutput && (usableDevices.length === 0 || labelsHidden);

  const unlock = async () => {
    setUnlocking(true);
    try {
      setDevices(await audioEngine.unlockOutputDevices());
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <SettingSection
      title="Audio output"
      description="Choose where previews play and at what sample rate."
    >
      {supportsOutput ? (
        <SettingRow
          label="Output device"
          description={
            needsUnlock
              ? 'macOS only reveals device names after granting audio access. Stack uses it solely to label outputs — it never records.'
              : 'Send sample previews to a specific output.'
          }
        >
          {needsUnlock ? (
            <Button variant="secondary" size="sm" onClick={unlock} disabled={unlocking}>
              {unlocking ? 'Requesting…' : 'Show devices'}
            </Button>
          ) : (
            <Select
              value={sinkId}
              options={deviceOptions}
              onChange={(v) => { setSinkId(v); audioEngine.setOutputDevice(v || null); }}
            />
          )}
        </SettingRow>
      ) : (
        <SettingRow
          label="Output device"
          description="This system doesn't let the app pick an output device. Previews follow your Mac's default output (change it in System Settings → Sound)."
        >
          <span className="mono text-xs text-gray-500">Unavailable</span>
        </SettingRow>
      )}
      <SettingRow
        label="Sample rate"
        description="Higher rates can sound cleaner but use more CPU. Changing this restarts the audio engine."
      >
        <Select
          value={sampleRate}
          options={SAMPLE_RATE_OPTIONS}
          onChange={(v) => {
            setSampleRate(v);
            audioEngine.setPreferredSampleRate(v ? Number(v) : null);
          }}
        />
      </SettingRow>
    </SettingSection>
  );
}

// ─── Audio diagnostics ──────────────────────────────────────────────────────────
// Surfaces the audio engine's live state so users on machines where preview is
// silent (e.g. the macOS Tahoe "scrubber moves, no sound" report) can send us the
// numbers. The Test tone button bypasses decode/buffer to isolate the output layer.

function AudioDiagnostics() {
  const [snap, setSnap] = useState(() => audioEngine.debugSnapshot());
  const [toneResult, setToneResult] = useState<string>('');
  const [verbose, setVerbose] = useState<boolean>(() => {
    try { return localStorage.getItem('stack:audioDebug') === '1'; } catch { return false; }
  });

  const refresh = () => setSnap(audioEngine.debugSnapshot());

  const runTone = async () => {
    try {
      const state = await audioEngine.playTestTone();
      setToneResult(`played (context: ${state})`);
    } catch (e) {
      setToneResult(`error: ${String(e)}`);
    }
    refresh();
  };

  const toggleVerbose = (v: boolean) => {
    setVerbose(v);
    try {
      if (v) localStorage.setItem('stack:audioDebug', '1');
      else localStorage.removeItem('stack:audioDebug');
    } catch { /* ignore */ }
  };

  const rows: Array<[string, string]> = [
    ['Context', snap.ctxExists ? snap.ctxState : 'not created'],
    ['Sample rate', snap.sampleRate ? `${snap.sampleRate} Hz` : '—'],
    ['Output gain', snap.gainValue != null ? snap.gainValue.toFixed(2) : '—'],
    ['Volume', snap.volume.toFixed(2)],
    ['Output latency', snap.outputLatency != null ? `${(snap.outputLatency * 1000).toFixed(1)} ms` : '—'],
    ['User gesture active', snap.userActivationActive === null ? 'unknown' : String(snap.userActivationActive)],
    ['Decoded in cache', String(snap.cacheSize)],
  ];

  return (
    <SettingSection
      title="Audio diagnostics"
      description="If preview playback is silent, click Test tone and send us these values."
    >
      <div className="rounded-md border border-gray-700 bg-gray-800 p-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3">
              <span className="text-xs text-gray-500">{k}</span>
              <span className="mono text-xs text-gray-200">{v}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={runTone}>Test tone</Button>
          <Button variant="secondary" size="sm" onClick={refresh}>Refresh</Button>
          {toneResult && <span className="mono text-xs text-gray-400">{toneResult}</span>}
        </div>
      </div>
      <SettingRow
        label="Verbose audio logging"
        description="Print detailed playback traces to the developer console (for support). Reload after enabling."
      >
        <Toggle checked={verbose} onChange={toggleVerbose} />
      </SettingRow>
    </SettingSection>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Settings = {
  defaultVolume: 0.9,
  autoPlayNext: false,
  indexerConcurrency: 8,
  analyzeAudioInBackground: true,
  watchForChanges: true,
  pageSize: 100,
  theme: 'dark',
  accentColor: null,
  showWaveform: true,
  showBpmBadge: true,
  showKeyBadge: true,
  showPlaygroundBadge: true,
  enablePlaygroundMode: true,
  launchAtStartup: false,
  confirmFolderRemoval: true,
  stickyToolbar: true,
  compactList: false,
  showTimeBadge: true,
  showFolderColumn: false,
  webAccessEnabled: true,
  webAccessLan: false,
  webAccessPort: 9870,
};

export function SettingsPage() {
  const qc = useQueryClient();
  const showPluginsNav = useUiStore((s) => s.showPluginsNav);
  const showProjectsNav = useUiStore((s) => s.showProjectsNav);
  const showSpliceNav = useUiStore((s) => s.showSpliceNav);
  const setShowPluginsNav = useUiStore((s) => s.setShowPluginsNav);
  const setShowProjectsNav = useUiStore((s) => s.setShowProjectsNav);
  const setShowSpliceNav = useUiStore((s) => s.setShowSpliceNav);

  const { data: savedSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsService.getSettings(),
  });

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [confirmDisablePlaygroundOpen, setConfirmDisablePlaygroundOpen] = useState(false);
  const [appVersion, setAppVersion] = useState<string>('');

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // Sync OS autostart state on mount
  useEffect(() => {
    settingsService.syncAutostart().catch(() => {});
  }, []);

  // Populate local state once settings load — also sync volume to player
  useEffect(() => {
    if (savedSettings) {
      setSettings(savedSettings);
      // Apply defaultVolume to the player store so the slider reflects the setting
      usePlayerStore.getState().setVolume(savedSettings.defaultVolume);
    }
  }, [savedSettings]);

  const updateAndSave = (patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      setSaving(true);
      settingsService
        .updateSettings(next)
        .then((updated) => {
          setSettings(updated);
          qc.setQueryData(['settings'], updated);
        })
        .finally(() => setSaving(false));
      return next;
    });
  };

  const handlePlaygroundModeToggle = (enabled: boolean) => {
    if (!enabled) {
      setConfirmDisablePlaygroundOpen(true);
      return;
    }
    updateAndSave({ enablePlaygroundMode: enabled });
  };

  const { data: folders = [] } = useQuery({
    queryKey: ['watched-folders'],
    queryFn: () => libraryService.getWatchedFolders(),
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: assetQueryKeys.all });
    qc.invalidateQueries({ queryKey: packQueryKeys.all });
    qc.invalidateQueries({ queryKey: libraryTreeKey });
    qc.invalidateQueries({ queryKey: ['watched-folders'] });
    qc.invalidateQueries({ queryKey: ['folder-info'] });
  };

  const remove = async (id: string) => {
    await libraryService.removeWatchedFolder(id);
    // Automatically clean cache after removing a folder
    await libraryService.cleanCache();
    invalidateAll();
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">

        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <h2 className="text-2xl font-bold text-stack-white">Settings</h2>
          {saving && <div className="text-xs text-gray-400">Saving...</div>}
        </div>

        {/* ── Watched Folders ── */}
        <SettingSection title="Watched Folders">
          <div className="mb-3 flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Refresh size={14} variant="Linear" color="currentColor" />}
              onClick={async () => { await libraryService.runReconciliation(); invalidateAll(); }}
            >
              Re-scan all
            </Button>
          </div>

          {folders.length === 0 ? (
            <div className="rounded-md border border-dashed border-gray-700 p-6 text-center text-sm text-gray-500">
              No folders watched yet. Add one from the sidebar.
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {folders.map((f) => (
                <FolderInfoRow key={f.id} folder={f} onRemove={() => remove(f.id)} />
              ))}
            </div>
          )}
        </SettingSection>

        {/* ── Application Preferences ── */}
        <SettingSection
          title="Application Preferences"
          description="Controls how Stack behaves at the system level."
        >
          <SettingRow
            label="Launch Stack at startup"
            description="Automatically open Stack when you log in to your Mac."
          >
            <Toggle
              checked={settings.launchAtStartup}
              onChange={(v) => updateAndSave({ launchAtStartup: v })}
            />
          </SettingRow>
          <SettingRow
            label="Confirm before removing a folder"
            description="Show a confirmation dialog when removing a watched folder."
          >
            <Toggle
              checked={settings.confirmFolderRemoval}
              onChange={(v) => updateAndSave({ confirmFolderRemoval: v })}
            />
          </SettingRow>
        </SettingSection>

        {/* ── Web access ── */}
        <WebAccessSettings settings={settings} onChange={updateAndSave} />

        {/* ── Playback ── */}
        <SettingSection
          title="Playback"
          description="Controls for audio preview behaviour."
        >
          <SettingRow
            label="Default volume"
            description="Starting volume level for audio previews."
          >
            <VolumeSlider
              value={settings.defaultVolume}
              onChange={(v) => {
                updateAndSave({ defaultVolume: v });
                // Live-preview: update the player immediately as you drag
                usePlayerStore.getState().setVolume(v);
              }}
            />
          </SettingRow>
          <SettingRow
            label="Auto-play next"
            description="Automatically play the next track when the current one ends."
          >
            <Toggle
              checked={settings.autoPlayNext}
              onChange={(v) => updateAndSave({ autoPlayNext: v })}
            />
          </SettingRow>
        </SettingSection>

        {/* ── Theme ── */}
        <SettingSection
          title="Theme"
          description="Pick a preset or choose your own accent. Applies to the entire app."
        >
          <ThemeSettings settings={settings} onChange={updateAndSave} />
        </SettingSection>

        {/* ── Appearance ── */}
        <SettingSection
          title="Appearance"
          description="Customise what's shown in the asset list."
        >
          <SettingRow
            label="Show Plugins in sidebar"
            description="Display the Plugins section in the left sidebar navigation."
          >
            <Toggle
              checked={showPluginsNav}
              onChange={setShowPluginsNav}
            />
          </SettingRow>
          <SettingRow
            label="Show Projects in sidebar"
            description="Display the Projects section in the left sidebar navigation."
          >
            <Toggle
              checked={showProjectsNav}
              onChange={setShowProjectsNav}
            />
          </SettingRow>
          <SettingRow
            label="Show Splice in sidebar"
            description="Display the Splice section in the left sidebar navigation."
          >
            <Toggle
              checked={showSpliceNav}
              onChange={setShowSpliceNav}
            />
          </SettingRow>
          <SettingRow
            label="Compact list view"
            description="Denser rows without the category line — see more samples at once. Right-click the column header to toggle individual columns."
          >
            <Toggle
              checked={settings.compactList}
              onChange={(v) => updateAndSave({ compactList: v })}
            />
          </SettingRow>
          <SettingRow
            label="Show waveform"
            description="Display the waveform visualiser in the player bar."
          >
            <Toggle
              checked={settings.showWaveform}
              onChange={(v) => updateAndSave({ showWaveform: v })}
            />
          </SettingRow>
          <SettingRow
            label="Show BPM badge"
            description="Display the BPM tag on each asset row."
          >
            <Toggle
              checked={settings.showBpmBadge}
              onChange={(v) => updateAndSave({ showBpmBadge: v })}
            />
          </SettingRow>
          <SettingRow
            label="Show key badge"
            description="Display the musical key tag on each asset row."
          >
            <Toggle
              checked={settings.showKeyBadge}
              onChange={(v) => updateAndSave({ showKeyBadge: v })}
            />
          </SettingRow>
          <SettingRow
            label="Sticky toolbar in browser"
            description="Keep the filter toolbar and column header pinned when scrolling inside a pack or folder."
          >
            <Toggle
              checked={settings.stickyToolbar}
              onChange={(v) => updateAndSave({ stickyToolbar: v })}
            />
          </SettingRow>
          <SettingRow
            label="Show Playground pill"
            description="Show Playground badge in sidebar while using virtual folder organization."
          >
            <Toggle
              checked={settings.showPlaygroundBadge}
              onChange={(v) => updateAndSave({ showPlaygroundBadge: v })}
            />
          </SettingRow>
          <SettingRow
            label="Enable Playground mode"
            description="Safe virtual folder organization. Turning this off enables real file moves on disk."
          >
            <Toggle
              checked={settings.enablePlaygroundMode}
              onChange={handlePlaygroundModeToggle}
            />
          </SettingRow>
        </SettingSection>

        {/* ── Plugins ── */}
        <SettingSection
          title="Plugins"
          description="Standard VST, VST3, AU, CLAP and AAX locations are scanned automatically."
        >
          <PluginFolderSettings />
        </SettingSection>

        {/* ── Library ── */}
        <SettingSection
          title="Library"
          description="Controls how your sample library is indexed and maintained."
        >
          <SettingRow
            label="Watch for file changes"
            description="Automatically re-index files when they are added, moved, or deleted."
          >
            <Toggle
              checked={settings.watchForChanges}
              onChange={(v) => updateAndSave({ watchForChanges: v })}
            />
          </SettingRow>
          <SettingRow
            label="Analyse audio in background"
            description="Generate waveforms and extract BPM/key data after indexing."
          >
            <Toggle
              checked={settings.analyzeAudioInBackground}
              onChange={(v) => updateAndSave({ analyzeAudioInBackground: v })}
            />
          </SettingRow>
          <SettingRow
            label="Indexer threads"
            description={`Parallel workers for scanning. Your machine has ${navigator.hardwareConcurrency ?? '?'} logical cores. For large libraries (100k+ files) use half your core count to avoid DB contention.`}
          >
            <Select
              value={settings.indexerConcurrency}
              options={[1, 2, 4, 6, 8, 12, 16, 24, 32].map((n) => ({
                value: n,
                label: n === navigator.hardwareConcurrency
                  ? `${n} threads (max)`
                  : `${n} threads`,
              }))}
              onChange={(v) => updateAndSave({ indexerConcurrency: Number(v) })}
            />
          </SettingRow>
          <SettingRow
            label="Results per page"
            description="How many assets to show per page in the browser."
          >
            <Select
              value={settings.pageSize}
              options={[50, 100, 200, 500].map((n) => ({ value: n, label: `${n} per page` }))}
              onChange={(v) => updateAndSave({ pageSize: Number(v) })}
            />
          </SettingRow>
        </SettingSection>

        {/* ── Audio output ── */}
        <AudioOutputSettings />

        {/* ── Audio diagnostics ── */}
        <AudioDiagnostics />

        {/* ── About ── */}
        <SettingSection title="About">
          <div className="rounded-md border border-gray-700 bg-gray-800 p-4 text-sm text-gray-300 space-y-2">
            <div><span className="text-gray-500">Version </span><span className="mono">{appVersion || '—'}</span></div>
            <div><span className="text-gray-500">Stack </span><span className="mono">Tauri 2 · React 18 · SQLite · Rust</span></div>
            <div className="pt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => window.dispatchEvent(new Event('stack:open-onboarding'))}
              >
                Open onboarding
              </Button>
            </div>
            <div className="pt-2">
              <a
                href="https://www.buymeacoffee.com/swendl"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-stack-fire hover:text-stack-fire-hover transition-colors"
              >
                <HeartAdd size={14} color="currentColor" variant="Bulk" aria-hidden />
                <span>Buy me a coffee</span>
              </a>
            </div>
          </div>
        </SettingSection>

      </div>

      {confirmDisablePlaygroundOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-xl border border-gray-700 bg-gray-900 p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-stack-white">Disable Playground mode?</h3>
            <p className="mt-2 text-sm text-gray-300">
              Turning Playground off means drag/reorder will move real folders on disk.
            </p>
            <p className="mt-1 text-sm text-gray-400">
              This can permanently change your actual sample-pack structure.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmDisablePlaygroundOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setConfirmDisablePlaygroundOpen(false);
                  updateAndSave({ enablePlaygroundMode: false });
                }}
              >
                Disable Playground
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
