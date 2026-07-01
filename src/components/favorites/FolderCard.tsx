import { useEffect, useRef, useState } from 'react';
import type { Stack } from '../../types';
import { FolderIcon } from '../ui/FolderIcon';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { FolderSettingsModal } from './FolderSettingsModal';
import { useDeleteStack } from '../../hooks/useStacks';
import { useStackDropZoneStore } from '../../stores/stackDropZoneStore';

interface FolderCardProps {
  stack: Stack;
  isActive: boolean;
  onOpen: (id: string) => void;
}

export function FolderCard({ stack, isActive, onOpen }: FolderCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const registerZone = useStackDropZoneStore((s) => s.registerZone);
  const unregisterZone = useStackDropZoneStore((s) => s.unregisterZone);

  const [showSettings, setShowSettings] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const deleteStack = useDeleteStack();

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const key = `strip:${stack.id}`;
    registerZone(key, stack.id, el);
    return () => unregisterZone(key);
  }, [stack.id, registerZone, unregisterZone]);

  const menuItems: ContextMenuItem[] = [
    { label: 'Folder settings…', onSelect: () => setShowSettings(true) },
    { label: '—', disabled: true, onSelect: () => {} },
    {
      label: 'Delete folder',
      danger: true,
      onSelect: () => deleteStack.mutate(stack.id),
    },
  ];

  return (
    <div
      ref={cardRef}
      onClick={() => onOpen(stack.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      className={`relative flex w-20 shrink-0 cursor-pointer flex-col items-center gap-1.5 rounded-lg p-2 text-center transition-colors ${
        isActive ? 'bg-gray-800' : 'hover:bg-gray-800/60'
      }`}
    >
      <FolderIcon color={stack.color ?? undefined} size={40} />
      <span className="w-full truncate text-xs text-gray-300">{stack.name}</span>
      <span className="mono text-[10px] text-gray-500">{stack.assetCount}</span>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {showSettings && (
        <FolderSettingsModal stack={stack} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
