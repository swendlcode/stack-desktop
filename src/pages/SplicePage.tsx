import { useEffect, useMemo } from 'react';
import { Button } from '../components/ui/Button';
import { Import, SpliceLogo } from '../components/ui/icons';
import { FacetDropdown } from '../components/browser/FacetDropdown';
import { useFilterStore } from '../stores/filterStore';
import { useUiStore } from '../stores/uiStore';
import {
  useImportSpliceLibrary,
  useSpliceDetection,
  useSplicePacks,
  normalizeFolderPath,
} from '../hooks/useSpliceLibrary';
import { BrowserPage } from './BrowserPage';
import type { SpliceLibrary } from '../types';

/**
 * Splice, as one library rather than a folder per pack.
 *
 * A Splice account downloads a handful of sounds from each pack it touches, so
 * a pack list is ~1,800 rows holding one or two files each — you have to open a
 * folder to find a single sample. The page scopes the ordinary browser to the
 * Splice roots instead: every sound in one view, with the same search, filters,
 * waveforms and player as the rest of the app. Narrowing to a pack is the Pack
 * dropdown, not a navigation step.
 */
export function SplicePage() {
  const { splicePacks, spliceRoots, isLoading } = useSplicePacks();
  const { data: detected, isLoading: detecting } = useSpliceDetection();
  const importLibrary = useImportSpliceLibrary();
  const setPathPrefixes = useFilterStore((s) => s.setPathPrefixes);
  const setPackIds = useFilterStore((s) => s.setPackIds);
  const resetFilters = useFilterStore((s) => s.resetFilters);
  const setBrowserViewMode = useUiStore((s) => s.setBrowserViewMode);

  // Join the roots so the effect keys off their contents, not the identity of
  // the array `useSpliceRoots` memoizes.
  const rootsKey = spliceRoots.join('\n');

  useEffect(() => {
    if (!rootsKey) return;
    resetFilters();
    setBrowserViewMode('pack');
    setPathPrefixes(rootsKey.split('\n'));
    // Release the scope on the way out — along with any pack picked here,
    // which would otherwise follow the user to the Browser as a few results
    // with nothing on screen explaining why.
    return () => {
      setPathPrefixes([]);
      setPackIds([]);
    };
  }, [rootsKey, resetFilters, setBrowserViewMode, setPathPrefixes, setPackIds]);

  if (!isLoading && splicePacks.length === 0) {
    return (
      <SpliceEmpty
        detected={detected ?? null}
        detecting={detecting}
        onImport={() => detected && importLibrary.mutate(detected)}
        importing={importLibrary.isPending}
        error={importLibrary.error}
      />
    );
  }

  const unimported =
    detected?.roots.filter((r) => !spliceRoots.includes(normalizeFolderPath(r.path))) ?? [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-gray-700 px-4 md:px-6">
        <SpliceLogo size={18} className="shrink-0 text-stack-fire" />
        <h2 className="shrink-0 text-lg font-bold text-stack-white">Splice</h2>
        <PackDropdown />
        <span className="mono ml-auto shrink-0 text-xs text-gray-500">
          {splicePacks.length.toLocaleString()} packs
        </span>
        {unimported.length > 0 && (
          <Button
            variant="primary"
            size="sm"
            disabled={importLibrary.isPending}
            icon={<Import size={14} variant="Linear" color="currentColor" />}
            onClick={() => detected && importLibrary.mutate(detected)}
          >
            {importLibrary.isPending ? 'Importing…' : `Import ${unimported.length} more`}
          </Button>
        )}
      </div>

      <BrowserPage />
    </div>
  );
}

/** Narrow the view to one or more Splice packs, reusing the facet list shape. */
function PackDropdown() {
  const { splicePacks } = useSplicePacks();
  const packIds = useFilterStore((s) => s.filters.packIds);
  const togglePack = useFilterStore((s) => s.togglePack);
  const setPathPrefix = useFilterStore((s) => s.setPathPrefix);

  const options = useMemo(
    () => splicePacks.map((p) => ({ value: p.id, count: p.assetCount })),
    [splicePacks]
  );
  const labels = useMemo(
    () => Object.fromEntries(splicePacks.map((p) => [p.id, p.name])),
    [splicePacks]
  );

  return (
    <FacetDropdown
      title="Pack"
      plural="packs"
      options={options}
      selected={packIds}
      onToggle={togglePack}
      onClear={() => {
        for (const id of packIds) togglePack(id);
        setPathPrefix(null);
      }}
      labels={labels}
    />
  );
}

function SpliceEmpty({
  detected,
  detecting,
  onImport,
  importing,
  error,
}: {
  detected: SpliceLibrary | null;
  detecting: boolean;
  onImport: () => void;
  importing: boolean;
  error: unknown;
}) {
  if (detecting) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-500">
        Looking for a Splice library…
      </div>
    );
  }

  if (!detected || detected.roots.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <SpliceLogo size={32} className="text-gray-600" />
        <h2 className="text-xl font-semibold text-stack-white">No Splice library found</h2>
        <p className="max-w-md text-sm text-gray-400">
          Add the folder from Settings if you keep it somewhere unusual.
        </p>
      </div>
    );
  }

  const folders = detected.roots.length;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <SpliceLogo size={32} className="text-stack-fire" />
      <h2 className="text-xl font-semibold text-stack-white">
        Splice library found — {detected.totalPacks.toLocaleString()} packs across {folders}{' '}
        {folders === 1 ? 'folder' : 'folders'}
      </h2>
      <p className="mono max-w-lg break-all text-xs text-gray-500">{detected.root}</p>
      <Button
        variant="primary"
        disabled={importing}
        icon={<Import size={16} variant="Linear" color="currentColor" />}
        onClick={onImport}
      >
        {importing ? 'Importing…' : 'Import'}
      </Button>
      {error ? (
        <p className="text-xs text-stack-fire">{String((error as Error)?.message ?? error)}</p>
      ) : null}
    </div>
  );
}
