import { useState } from 'react';
import { Button } from '../ui/Button';
import { CloseCircle, Import, SpliceLogo } from '../ui/icons';
import { useImportSpliceLibrary, useSpliceDetection } from '../../hooks/useSpliceLibrary';

const DISMISSED_KEY = 'stack:splicePromptDismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * First-run shortcut: an installed Splice library is a whole sample collection
 * already on disk, so offer it next to the folder picker rather than making the
 * user hunt for `~/Splice/sounds/packs` themselves. Renders nothing when there
 * is no library or the user dismissed the offer.
 */
export function SpliceImportPrompt() {
  const { data: detected } = useSpliceDetection();
  const importLibrary = useImportSpliceLibrary();
  const [dismissed, setDismissed] = useState(readDismissed);

  if (dismissed || !detected || detected.roots.length === 0) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {}
    setDismissed(true);
  };

  const folders = detected.roots.length;

  return (
    <div className="flex w-full max-w-md items-center gap-3 rounded-lg border border-stack-fire/40 bg-stack-fire/5 px-4 py-3 text-left">
      <SpliceLogo size={20} className="shrink-0 text-stack-fire" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-stack-white">
          Splice library found — {detected.totalPacks.toLocaleString()} packs
        </div>
        <div className="mono truncate text-xs text-gray-500" title={detected.root}>
          {folders === 1 ? detected.root : `${detected.root} · ${folders} folders`}
        </div>
      </div>
      <Button
        variant="primary"
        size="sm"
        disabled={importLibrary.isPending}
        icon={<Import size={14} variant="Linear" color="currentColor" />}
        onClick={() => importLibrary.mutate(detected)}
      >
        {importLibrary.isPending ? 'Importing…' : 'Import'}
      </Button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss Splice import"
        className="shrink-0 text-gray-500 transition-colors hover:text-stack-white"
      >
        <CloseCircle size={16} color="currentColor" variant="Linear" />
      </button>
    </div>
  );
}
