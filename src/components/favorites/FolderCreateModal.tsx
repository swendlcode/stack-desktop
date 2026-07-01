import { useEffect, useState } from 'react';
import { FolderIcon } from '../ui/FolderIcon';
import { FolderColorPicker } from './FolderColorPicker';
import { CloseCircle } from '../ui/icons';
import { DEFAULT_FOLDER_COLOR } from '../../utils/colorUtils';
import { useCreateStack, useSetStackColor } from '../../hooks/useStacks';

interface FolderCreateModalProps {
  onClose: () => void;
  onCreated: (stackId: string) => void;
}

/** Folder creation modal — name + any color — mirrors FolderSettingsModal's layout. */
export function FolderCreateModal({ onClose, onCreated }: FolderCreateModalProps) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_FOLDER_COLOR);
  const createStack = useCreateStack();
  const setStackColor = useSetStackColor();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const commit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    createStack.mutate(trimmed, {
      onSuccess: (stack) => {
        if (color !== DEFAULT_FOLDER_COLOR) setStackColor.mutate({ id: stack.id, color });
        onCreated(stack.id);
        onClose();
      },
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Create folder"
    >
      <div
        className="w-[min(420px,94vw)] overflow-hidden rounded-lg border border-gray-700 bg-stack-black shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-gray-700/70 px-4 py-3">
          <h2 className="text-sm font-semibold text-stack-white">New folder</h2>
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
              placeholder="Folder name"
              className="rounded-md border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-stack-white focus:border-stack-fire focus:outline-none"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[10px] uppercase tracking-widest text-gray-500">Color</label>
            <FolderColorPicker color={color} onChange={setColor} />
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={commit}
              disabled={!name.trim()}
              className="rounded-md bg-stack-fire px-4 py-1.5 text-xs font-semibold text-stack-black hover:bg-stack-fire/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Create folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
