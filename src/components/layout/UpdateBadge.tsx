import { useState } from 'react';
import { ArrowUp2, CloseCircle, Refresh, TickCircle } from '../ui/icons';
import { useAppUpdate } from '../../hooks/useAppUpdate';

/**
 * In-app update control. Downloads in the background while the app stays
 * usable, and only restarts when the user chooses to.
 */
export function UpdateBadge() {
  const { stage, version, progress, error, install, restart } = useAppUpdate();
  const [dismissed, setDismissed] = useState(false);

  if (stage === 'idle' || dismissed) return null;

  const shell =
    'flex items-center gap-1 rounded-md border border-stack-fire/30 bg-stack-fire/10 pl-2 pr-1 py-1';

  if (stage === 'downloading') {
    const pct = progress === null ? null : Math.round(progress * 100);
    return (
      <div className={shell} title={`Downloading Stack v${version}`}>
        <Refresh size={11} color="currentColor" variant="Linear" className="animate-spin" />
        <span className="mono text-xs font-medium text-stack-fire">
          {pct === null ? 'Updating…' : `${pct}%`}
        </span>
      </div>
    );
  }

  if (stage === 'ready') {
    return (
      <div className={shell}>
        <button
          onClick={restart}
          className="flex items-center gap-1 text-xs font-medium text-stack-fire transition-colors hover:text-stack-fire/80"
          title={`Stack v${version} is installed — restart to finish`}
        >
          <TickCircle size={11} color="currentColor" variant="Bold" />
          Restart to update
        </button>
      </div>
    );
  }

  if (stage === 'error') {
    return (
      <div className="flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 pl-2 pr-1 py-1">
        <span className="text-xs font-medium text-red-300" title={error ?? undefined}>
          Update failed
        </span>
        <button
          onClick={() => setDismissed(true)}
          className="ml-0.5 text-red-300/60 transition-colors hover:text-red-300"
          aria-label="Dismiss"
        >
          <CloseCircle size={13} color="currentColor" variant="Linear" />
        </button>
      </div>
    );
  }

  return (
    <div className={shell}>
      <button
        onClick={install}
        className="flex items-center gap-1 text-xs font-medium text-stack-fire transition-colors hover:text-stack-fire/80"
        title={`Stack v${version} is available — click to update`}
      >
        <ArrowUp2 size={11} color="currentColor" variant="Bold" />
        Update to v{version}
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="ml-0.5 text-stack-fire/60 transition-colors hover:text-stack-fire"
        aria-label="Dismiss update"
      >
        <CloseCircle size={13} color="currentColor" variant="Linear" />
      </button>
    </div>
  );
}
