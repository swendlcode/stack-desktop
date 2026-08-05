import { useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Badge } from '../ui/Badge';
import { ContextMenu } from '../ui/ContextMenu';
import { Trash } from '../ui/icons';
import { formatFileSize } from '../../utils/formatters';
import type { PluginEntry } from '../../types';

// Shared column widths so the header and rows stay aligned.
const COL = { format: 56, vendor: 144, size: 80, kind: 64, actions: 36 };

const LABEL_CLS = 'text-xs font-medium uppercase tracking-widest text-gray-500';

export function PluginColumnHeader() {
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-gray-700 bg-gray-900 px-6">
      <span style={{ width: COL.format }} className={`${LABEL_CLS} shrink-0`}>
        Format
      </span>
      <span className={`${LABEL_CLS} min-w-0 flex-1`}>Name</span>
      <span style={{ width: COL.vendor }} className={`${LABEL_CLS} hidden shrink-0 md:block`}>
        Vendor
      </span>
      <span className={`${LABEL_CLS} hidden min-w-0 flex-1 lg:block`}>Path</span>
      <span
        style={{ width: COL.size }}
        className={`mono ${LABEL_CLS} shrink-0 text-right`}
      >
        Size
      </span>
      <span style={{ width: COL.kind }} className={`${LABEL_CLS} shrink-0 text-center`}>
        Type
      </span>
      <span style={{ width: COL.actions }} className="shrink-0" />
    </div>
  );
}

interface PluginListProps {
  plugins: PluginEntry[];
  onDelete: (plugin: PluginEntry) => void;
}

interface MenuState {
  x: number;
  y: number;
  plugin: PluginEntry;
}

export function PluginList({ plugins, onDelete }: PluginListProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  return (
    <>
      {plugins.map((p) => {
        const siblingFormats = Array.from(new Set(p.siblings.map((s) => s.format)));
        return (
          <div
            key={p.path}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, plugin: p });
            }}
            className="group flex items-center gap-3 border-b border-gray-700/50 px-6 py-2.5 transition-colors hover:bg-gray-800/40"
          >
            <div style={{ width: COL.format }} className="flex shrink-0">
              <Badge tone="muted" className="w-full justify-center uppercase tracking-widest">
                {p.format}
              </Badge>
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-sm font-medium text-stack-white">{p.name}</span>
              {siblingFormats.map((f) => (
                <span
                  key={f}
                  title={`Also installed as ${f.toUpperCase()}`}
                  className="shrink-0 rounded border border-gray-700 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-gray-500"
                >
                  +{f}
                </span>
              ))}
            </div>
            <span
              style={{ width: COL.vendor }}
              className="hidden shrink-0 truncate text-xs text-gray-400 md:block"
              title={p.vendor ?? undefined}
            >
              {p.vendor ?? '—'}
            </span>
            <span
              className="mono hidden min-w-0 flex-1 truncate text-[11px] text-gray-500 lg:block"
              title={p.path}
            >
              {p.path}
            </span>
            <span
              style={{ width: COL.size }}
              className="mono shrink-0 text-right text-[11px] text-gray-500"
            >
              {p.sizeBytes > 0 ? formatFileSize(p.sizeBytes) : '—'}
            </span>
            <div style={{ width: COL.kind }} className="flex shrink-0 justify-center">
              <span className="rounded border border-gray-700 px-2 py-0.5 text-[10px] uppercase tracking-widest text-gray-400">
                {p.kind === 'instrument' ? 'VSTi' : p.kind}
              </span>
            </div>
            <div style={{ width: COL.actions }} className="flex shrink-0 justify-center">
              <button
                onClick={() => onDelete(p)}
                title="Delete plugin…"
                aria-label={`Delete ${p.name}`}
                className="rounded p-1.5 text-gray-500 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
              >
                <Trash size={14} color="currentColor" variant="Linear" />
              </button>
            </div>
          </div>
        );
      })}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Reveal in Finder',
              onSelect: () => revealItemInDir(menu.plugin.path).catch(() => {}),
            },
            { label: '—', onSelect: () => {} },
            {
              label: 'Delete Plugin…',
              danger: true,
              onSelect: () => onDelete(menu.plugin),
            },
          ]}
        />
      )}
    </>
  );
}
