import { useMemo, useState } from 'react';
import { Button } from '../components/ui/Button';
import { Refresh } from '../components/ui/icons';
import { PluginList } from '../components/plugins/PluginList';
import { DeletePluginModal } from '../components/plugins/DeletePluginModal';
import { usePluginScan } from '../hooks/usePlugins';
import { loadCustomPluginPaths } from '../utils/pluginPaths';
import type { PluginEntry } from '../types';

type FilterMode = 'all' | 'vst' | 'vst3' | 'au' | 'clap' | 'aax' | 'vsti';

const BUTTONS: Array<{ id: FilterMode; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'vst', label: 'VST' },
  { id: 'vst3', label: 'VST3' },
  { id: 'au', label: 'AU' },
  { id: 'clap', label: 'CLAP' },
  { id: 'aax', label: 'AAX' },
  { id: 'vsti', label: 'VSTi' },
];

export function PluginsPage() {
  // Standard locations are discovered automatically; extra folders are managed
  // in Settings and only read here.
  const [customPaths] = useState<string[]>(loadCustomPluginPaths);
  const [mode, setMode] = useState<FilterMode>('all');
  const [deleteTarget, setDeleteTarget] = useState<PluginEntry | null>(null);

  const { data: plugins = [], isLoading, isFetching, refetch } = usePluginScan(customPaths);

  const filtered = useMemo(() => {
    if (mode === 'all') return plugins;
    if (mode === 'vsti') return plugins.filter((p) => p.kind === 'instrument');
    return plugins.filter((p) => p.format === mode);
  }, [plugins, mode]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center border-b border-gray-700 px-6">
        <h2 className="text-lg font-bold text-stack-white">Plugins</h2>
        <div className="mono ml-auto mr-4 text-xs text-gray-400">
          {plugins.length.toLocaleString()} {plugins.length === 1 ? 'plugin' : 'plugins'}
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<Refresh size={14} color="currentColor" variant="Linear" />}
          onClick={() => refetch()}
          disabled={isFetching}
        >
          Rescan
        </Button>
      </div>

      <div className="shrink-0 border-b border-gray-700/70 px-6 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {BUTTONS.map((b) => {
            const active = mode === b.id;
            return (
              <button
                key={b.id}
                onClick={() => setMode(b.id)}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? 'border-stack-fire bg-stack-fire/15 text-stack-fire'
                    : 'border-gray-700 text-gray-300 hover:border-gray-500 hover:bg-gray-800 hover:text-stack-white'
                }`}
              >
                {b.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-gray-500">
            Scanning plugins...
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-gray-500">
            <div className="text-lg font-semibold text-gray-400">No plugins found</div>
            <div className="text-sm">
              Plugins installed in the standard system locations appear here automatically.
              <br />
              Extra folders can be added in Settings.
            </div>
          </div>
        ) : (
          <PluginList plugins={filtered} onDelete={setDeleteTarget} />
        )}
      </div>

      {deleteTarget && (
        <DeletePluginModal
          plugin={deleteTarget}
          extraPaths={customPaths}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
