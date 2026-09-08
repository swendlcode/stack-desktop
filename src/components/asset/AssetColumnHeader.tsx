/**
 * Sticky column header that mirrors AssetRow's layout. Per-type column sets
 * (samples/midi keep waveform/time/key/bpm; presets show only Plugin; projects
 * show DAW + Date) are driven by the `viewType` prop. Right-click opens a menu
 * that toggles column visibility and row density (persisted in Settings).
 */
import { useState } from 'react';
import { useSelectionStore } from '../../stores/selectionStore';
import { useColumnPrefs } from '../../hooks/useColumnPrefs';
import { Checkbox } from '../ui/Checkbox';
import { ContextMenu } from '../ui/ContextMenu';
import { COL } from './assetColumns';

export type AssetViewType = 'sample' | 'midi' | 'preset' | 'project' | 'favorites';

const LABEL_CLS = 'text-xs font-medium uppercase tracking-widest text-gray-500';
const MONO_CLS = 'mono text-xs font-medium uppercase tracking-widest text-gray-500';

export function AssetColumnHeader({
  viewType = 'sample',
  pageAssetIds = [],
  showWaveform = true,
  showBpmBadge = true,
  showKeyBadge = true,
  showTimeBadge = true,
  showFolderColumn = false,
  compact = false,
}: {
  viewType?: AssetViewType;
  pageAssetIds?: string[];
  showWaveform?: boolean;
  showBpmBadge?: boolean;
  showKeyBadge?: boolean;
  showTimeBadge?: boolean;
  showFolderColumn?: boolean;
  compact?: boolean;
}) {
  const { selectedIds, setSelection, clearSelection } = useSelectionStore();
  const { settings, toggle } = useColumnPrefs();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const selectedCount = pageAssetIds.filter((id) => selectedIds.has(id)).length;
  const allSelected = pageAssetIds.length > 0 && selectedCount === pageAssetIds.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelection(pageAssetIds);
    } else {
      clearSelection();
    }
  };

  const mark = (on: boolean) => (on ? '\u2713  ' : '\u2007\u2007 ');

  return (
    <div
      className="sticky top-0 z-10 flex shrink-0 items-center border-b border-gray-700 bg-gray-900"
      style={{ height: 32, paddingLeft: '12px', paddingRight: '12px' }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      title="Right-click to choose columns"
    >
      {/* ── CHECKBOX: select-all ── */}
      <div
        className="flex shrink-0 items-center justify-center mr-2"
        style={{ width: COL.checkbox }}
      >
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onChange={handleSelectAll}
          aria-label={allSelected ? 'Deselect all on page' : 'Select all on page'}
        />
      </div>

      {/* ── LEFT: Filename ── */}
      <div className="flex min-w-0 flex-[0.85] items-center" style={{ minWidth: '200px' }}>
        {/* Spacer for artwork + play + gaps — must track AssetRow's geometry */}
        <div style={{ width: compact ? 28 + 24 + 20 : 42 + 32 + 20 }} className="shrink-0" />
        <span className={LABEL_CLS}>Filename</span>
      </div>

      {/* ── CENTRE: type-specific columns ── */}
      <div className="flex min-w-0 flex-[1.15] items-center justify-center gap-1 sm:gap-3 px-2 sm:px-4">
        {(viewType === 'sample' || viewType === 'midi' || viewType === 'favorites') && (
          <>
            {showWaveform && (
              <div className="hidden lg:flex flex-1 min-w-0 overflow-hidden items-center justify-center">
                <span className={LABEL_CLS}>
                  {viewType === 'midi' ? 'MIDI' : viewType === 'favorites' ? 'Preview' : 'Waveform'}
                </span>
              </div>
            )}
            {showTimeBadge && (
              <div className="shrink-0 text-right" style={{ minWidth: '40px' }}>
                <span className={MONO_CLS}>Time</span>
              </div>
            )}
            {showKeyBadge && (
              <div className="shrink-0 text-center" style={{ minWidth: '50px' }}>
                <span className={MONO_CLS}>Key</span>
              </div>
            )}
            {showBpmBadge && (
              <div className="shrink-0 text-center" style={{ minWidth: '45px' }}>
                <span className={MONO_CLS}>BPM</span>
              </div>
            )}
          </>
        )}

        {viewType === 'preset' && (
          <div className="flex flex-1 items-center justify-end pr-2">
            <span className={LABEL_CLS}>Plugin</span>
          </div>
        )}

        {viewType === 'project' && (
          <>
            <div className="flex flex-1 items-center justify-center">
              <span className={LABEL_CLS}>DAW</span>
            </div>
            <div className="shrink-0 text-right" style={{ minWidth: '90px' }}>
              <span className={MONO_CLS}>Date</span>
            </div>
          </>
        )}
      </div>

      {/* ── FOLDER: optional path column ── */}
      {showFolderColumn && (
        <div className="hidden shrink-0 xl:block" style={{ width: 160 }}>
          <span className={LABEL_CLS}>Folder</span>
        </div>
      )}

      {/* ── RIGHT: spacer for fav + more ── */}
      <div className="shrink-0" style={{ minWidth: '50px' }} />

      {menu && settings && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: `${mark(settings.showWaveform)}Waveform`, onSelect: () => toggle('showWaveform') },
            { label: `${mark(settings.showTimeBadge)}Time`, onSelect: () => toggle('showTimeBadge') },
            { label: `${mark(settings.showKeyBadge)}Key`, onSelect: () => toggle('showKeyBadge') },
            { label: `${mark(settings.showBpmBadge)}BPM`, onSelect: () => toggle('showBpmBadge') },
            { label: `${mark(settings.showFolderColumn)}Folder`, onSelect: () => toggle('showFolderColumn') },
            { label: '—', onSelect: () => {} },
            { label: `${mark(settings.compactList)}Compact rows`, onSelect: () => toggle('compactList') },
          ]}
        />
      )}
    </div>
  );
}
