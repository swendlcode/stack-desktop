import { useEffect, useState } from 'react';
import type { Stack } from '../../types';
import { FolderIcon } from '../ui/FolderIcon';
import { FolderColorPicker } from './FolderColorPicker';
import { CloseCircle, Trash } from '../ui/icons';
import { DEFAULT_FOLDER_COLOR } from '../../utils/colorUtils';
import { useRenameStack, useSetStackColor, useDeleteStack } from '../../hooks/useStacks';

interface FolderSettingsModalProps {
  stack: Stack;
  onClose: () => void;
  onDeleted?: () => void;
}

/** Folder settings modal — name, color — mirrors CoverEditorModal's layout. */
export function FolderSettingsModal({ stack, onClose, onDeleted }: FolderSettingsModalProps) {
  const [name, setName] = useState(stack.name);
  const [color, setColor] = useState(stack.color ?? DEFAULT_FOLDER_COLOR);
  const renameStack = useRenameStack();
  const setStackColor = useSetStackColor();
  const deleteStack = useDeleteStack();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== stack.name) renameStack.mutate({ id: stack.id, name: trimmed });
    if (color !== stack.color) setStackColor.mutate({ id: stack.id, color });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Folder settings"
    >
      <div
        className="w-[min(420px,94vw)] overflow-hidden rounded-lg border border-gray-700 bg-stack-black shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-gray-700/70 px-4 py-3">
          <h2 className="text-sm font-semibold text-stack-white">Folder settings</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-stack-white"
            aria-label="Close"
            title="Close (Esc)"
          >
            <CloseCircle size={18} color="currentColor" variant="Linear" />
          </button>
        </header>

        <div className="flex flex-col gap-4 p-4">
          <div className="flex justify-center py-2">
            <FolderIcon color={color} size={72} />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[10px] uppercase tracking-widest text-gray-500">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
              className="rounded-md border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-stack-white focus:border-stack-fire focus:outline-none"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[10px] uppercase tracking-widest text-gray-500">Color</label>
            <FolderColorPicker color={color} onChange={setColor} />
          </div>

          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => {
                deleteStack.mutate(stack.id);
                onDeleted?.();
                onClose();
              }}
              className="flex items-center gap-1.5 rounded-md border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10"
            >
              <Trash size={14} color="currentColor" variant="Linear" />
              Delete folder
            </button>
            <button
              onClick={commit}
              className="rounded-md bg-stack-fire px-4 py-1.5 text-xs font-semibold text-stack-black hover:bg-stack-fire/90"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
