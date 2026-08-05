import { useMemo, useState } from 'react';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { CloseCircle, Refresh, SearchNormal } from '../components/ui/icons';
import { PluginColumnHeader, PluginList } from '../components/plugins/PluginList';
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
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PluginEntry | null>(null);

  const { data: plugins = [], isLoading, isFetching, refetch } = usePluginScan(customPaths);

  const filtered = useMemo(() => {
    let list = plugins;
    if (mode === 'vsti') list = list.filter((p) => p.kind === 'instrument');
    else if (mode !== 'all') list = list.filter((p) => p.format === mode);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.vendor?.toLowerCase().includes(q) ?? false) ||
          p.path.toLowerCase().includes(q),
      );
    }
    return list;
  }, [plugins, mode, search]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center border-b border-gray-700 px-6">
        <h2 className="text-lg font-bold text-stack-white">Plugins</h2>
        <div className="mono ml-auto mr-4 text-xs text-gray-400">
          {search || mode !== 'all'
            ? `${filtered.length.toLocaleString()} of ${plugins.length.toLocaleString()} plugins`
            : `${plugins.length.toLocaleString()} ${plugins.length === 1 ? 'plugin' : 'plugins'}`}
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

      <div className="shrink-0 border-b border-gray-700/70 px-6 py-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <Input
            className="w-72"
            placeholder="Search plugins…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leading={
              <SearchNormal size={15} color="var(--color-text-muted)" variant="Linear" />
            }
            trailing={
              search ? (
                <button onClick={() => setSearch('')} aria-label="Clear search">
                  <CloseCircle size={15} color="var(--color-text-muted)" variant="Linear" />
                </button>
              ) : null
            }
          />
          <div className="h-5 w-px bg-gray-700" />
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

      {!isLoading && filtered.length > 0 && <PluginColumnHeader />}

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-gray-500">
            Scanning plugins...
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-gray-500">
            <div className="text-lg font-semibold text-gray-400">
              {search ? 'No plugins match your search' : 'No plugins found'}
            </div>
            <div className="text-sm">
              {search ? (
                'Try a different name, vendor, or path.'
              ) : (
                <>
                  Plugins installed in the standard system locations appear here automatically.
                  <br />
                  Extra folders can be added in Settings.
                </>
              )}
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
