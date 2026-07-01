import { useEffect, useRef } from 'react';
import type { Stack } from '../../types';
import { FolderIcon } from '../ui/FolderIcon';
import { useStackDropZoneStore } from '../../stores/stackDropZoneStore';

interface SidebarFolderRowProps {
  stack: Stack;
  isActive: boolean;
  onSelect: (id: string) => void;
}

/**
 * A favorites folder shown in the sidebar tree. Registers itself as a drop
 * zone so an asset dragged from any page (Browser, MIDI…) can be dropped
 * straight onto it — handled globally by useStackDropListener.
 */
export function SidebarFolderRow({ stack, isActive, onSelect }: SidebarFolderRowProps) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const registerZone = useStackDropZoneStore((s) => s.registerZone);
  const unregisterZone = useStackDropZoneStore((s) => s.unregisterZone);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const key = `sidebar:${stack.id}`;
    registerZone(key, stack.id, el);
    return () => unregisterZone(key);
  }, [stack.id, registerZone, unregisterZone]);

  return (
    <button
      ref={rowRef}
      onClick={() => onSelect(stack.id)}
      className={`flex items-center gap-2 rounded-md py-1 pl-8 pr-2 text-[13px] transition-colors ${
        isActive
          ? 'bg-stack-fire/10 text-stack-fire'
          : 'text-gray-400 hover:bg-gray-800 hover:text-stack-white'
      }`}
    >
      <FolderIcon color={stack.color ?? undefined} size={15} showMark={false} />
      <span className="min-w-0 flex-1 truncate text-left">{stack.name}</span>
      <span className="mono shrink-0 text-[10px] text-gray-500">{stack.assetCount}</span>
    </button>
  );
}
