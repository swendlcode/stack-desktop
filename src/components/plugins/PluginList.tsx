import { useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Badge } from '../ui/Badge';
import { ContextMenu } from '../ui/ContextMenu';
import { Trash } from '../ui/icons';
import { formatFileSize } from '../../utils/formatters';
import type { PluginEntry } from '../../types';

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
    <div className="overflow-hidden rounded-lg border border-gray-700">
      {plugins.map((p) => {
        const siblingFormats = Array.from(new Set(p.siblings.map((s) => s.format)));
        return (
          <div
            key={p.path}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, plugin: p });
            }}
            className="group flex items-center gap-3 border-b border-gray-700/50 px-4 py-2.5 transition-colors last:border-b-0 hover:bg-gray-800/40"
          >
            <Badge tone="muted" className="w-14 shrink-0 justify-center uppercase tracking-widest">
              {p.format}
            </Badge>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-stack-white">{p.name}</span>
                {p.vendor && (
                  <span className="hidden truncate text-xs text-gray-500 sm:inline">
                    {p.vendor}
                  </span>
                )}
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
              <div className="mono truncate text-[11px] text-gray-500">{p.path}</div>
            </div>
            <span className="mono shrink-0 text-[11px] text-gray-500">
              {p.sizeBytes > 0 ? formatFileSize(p.sizeBytes) : '—'}
            </span>
            <span className="shrink-0 rounded border border-gray-700 px-2 py-0.5 text-[10px] uppercase tracking-widest text-gray-400">
              {p.kind === 'instrument' ? 'VSTi' : p.kind}
            </span>
            <button
              onClick={() => onDelete(p)}
              title="Delete plugin…"
              aria-label={`Delete ${p.name}`}
              className="shrink-0 rounded p-1.5 text-gray-500 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
            >
              <Trash size={14} color="currentColor" variant="Linear" />
            </button>
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
    </div>
  );
}
