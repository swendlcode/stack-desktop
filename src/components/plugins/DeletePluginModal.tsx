import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import { CloseCircle, TickCircle, Trash, Warning2 } from '../ui/icons';
import { useDeletePlugin, usePluginLeftovers } from '../../hooks/usePlugins';
import { formatFileSize } from '../../utils/formatters';
import type { PluginEntry } from '../../types';
import { LeftoverChecklist } from './LeftoverChecklist';

interface DeletePluginModalProps {
  plugin: PluginEntry;
  extraPaths: string[];
  onClose: () => void;
}

export function DeletePluginModal({ plugin, extraPaths, onClose }: DeletePluginModalProps) {
  const { data: report, isLoading, error } = usePluginLeftovers(plugin.path, extraPaths);
  const deletion = useDeletePlugin();
  const [selections, setSelections] = useState<Record<string, boolean>>({});

  // Everything found is preselected except shared vendor locations.
  useEffect(() => {
    if (!report) return;
    const initial: Record<string, boolean> = {};
    for (const item of report.items) initial[item.path] = !item.shared;
    setSelections(initial);
  }, [report]);

  const chosen = report?.items.filter((i) => selections[i.path]) ?? [];
  const chosenSize = chosen.reduce((sum, i) => sum + i.sizeBytes, 0);
  const result = deletion.data;

  const confirm = () => {
    deletion.mutate({
      paths: chosen.filter((i) => !i.isRegistryKey).map((i) => i.path),
      registryKeys: chosen.filter((i) => i.isRegistryKey).map((i) => i.path),
      extraRoots: extraPaths,
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Delete ${plugin.name}`}
    >
      <div
        className="w-[min(560px,94vw)] overflow-hidden rounded-xl border border-gray-700 bg-stack-black shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-gray-700/70 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <Trash size={16} color="var(--color-stack-fire)" variant="Linear" />
            <div>
              <h2 className="text-sm font-semibold text-stack-white">Delete {plugin.name}</h2>
              <p className="text-[11px] text-gray-500">
                {report?.vendor ? `${report.vendor} · ` : ''}
                {plugin.format.toUpperCase()}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-stack-white"
            aria-label="Close"
          >
            <CloseCircle size={18} color="currentColor" variant="Linear" />
          </button>
        </header>

        <div className="flex flex-col gap-4 p-5">
          {result ? (
            <ResultStep result={result} onClose={onClose} />
          ) : isLoading ? (
            <div className="py-8 text-center text-sm text-gray-500">
              Searching for related files…
            </div>
          ) : error || !report ? (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              Could not analyze this plugin: {String(error ?? 'unknown error')}
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-400">
                Everything below will be <span className="text-red-300">permanently deleted</span>{' '}
                — this cannot be undone. Uncheck anything you want to keep.
              </p>
              <LeftoverChecklist
                report={report}
                selections={selections}
                onToggle={(path, checked) =>
                  setSelections((prev) => ({ ...prev, [path]: checked }))
                }
              />
              {report.needsElevation && (
                <p className="text-[11px] text-gray-500">
                  Some files are in system locations — administrator access will be requested
                  once.
                </p>
              )}
              <div className="flex items-center justify-between border-t border-gray-700/60 pt-4">
                <Button variant="secondary" size="sm" onClick={onClose}>
                  Cancel
                </Button>
                <button
                  onClick={confirm}
                  disabled={chosen.length === 0 || deletion.isPending}
                  className="flex items-center gap-1.5 rounded-md border border-red-500/40 px-3 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Warning2 size={14} color="currentColor" variant="Linear" />
                  {deletion.isPending
                    ? 'Deleting…'
                    : `Delete ${chosen.length} item${chosen.length === 1 ? '' : 's'} (${formatFileSize(chosenSize)})`}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ResultStep({
  result,
  onClose,
}: {
  result: NonNullable<ReturnType<typeof useDeletePlugin>['data']>;
  onClose: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2 text-sm text-stack-white">
        {result.failed.length === 0 ? (
          <TickCircle size={16} color="var(--color-stack-fire)" variant="Linear" />
        ) : (
          <Warning2 size={16} color="currentColor" variant="Linear" />
        )}
        {result.deleted.length} item{result.deleted.length === 1 ? '' : 's'} deleted
        {result.bytesFreed > 0 && ` — ${formatFileSize(result.bytesFreed)} freed`}
      </div>
      {result.elevationCancelled && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          Administrator authorization was cancelled — items in system locations were left in
          place.
        </div>
      )}
      {result.failed.length > 0 && (
        <div className="flex max-h-[30vh] flex-col gap-1.5 overflow-y-auto">
          <div className="text-[10px] uppercase tracking-widest text-gray-500">
            Could not delete
          </div>
          {result.failed.map((f) => (
            <div key={f.path} className="rounded-md bg-gray-900/70 px-2 py-1.5">
              <div className="mono truncate text-[11px] text-gray-300" title={f.path}>
                {f.path}
              </div>
              <div className="text-[11px] text-gray-500">{f.error}</div>
            </div>
          ))}
          <p className="text-[11px] text-gray-500">
            If a file is in use, close your DAW and try again.
          </p>
        </div>
      )}
      <div className="flex justify-end border-t border-gray-700/60 pt-4">
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  );
}
