import { useState } from 'react';
import { useStacks } from '../../hooks/useStacks';
import { FolderCard } from './FolderCard';
import { FolderCreateModal } from './FolderCreateModal';
import { Heart, Add } from '../ui/icons';

interface FavoritesFolderStripProps {
  activeStackId: string | null;
  onSelect: (id: string | null) => void;
}

/**
 * Horizontal, scrollable row of favorite folders shown under the Favorites
 * title. Drops onto a folder card are handled globally by useStackDropListener
 * (mounted in App), so this component stays purely presentational.
 */
export function FavoritesFolderStrip({ activeStackId, onSelect }: FavoritesFolderStripProps) {
  const { data: stacks = [] } = useStacks();
  const [showCreateModal, setShowCreateModal] = useState(false);

  return (
    <div className="flex items-start gap-2 overflow-x-auto overflow-y-hidden border-b border-gray-700 px-6 py-3">
      <button
        onClick={() => onSelect(null)}
        aria-label="All favorites"
        title="All favorites"
        className={`flex h-[76px] w-20 shrink-0 items-center justify-center rounded-lg text-stack-fire transition-colors ${
          activeStackId === null ? 'bg-gray-800' : 'hover:bg-gray-800/60'
        }`}
      >
        <Heart size={26} color="currentColor" variant="Bold" />
      </button>

      <button
        onClick={() => setShowCreateModal(true)}
        className="flex h-[76px] w-20 shrink-0 items-center justify-center rounded-lg border-2 border-dashed border-stack-fire/40 text-stack-fire transition-colors hover:border-stack-fire"
        aria-label="New folder"
        title="New folder"
      >
        <Add size={22} color="currentColor" variant="Bold" />
      </button>

      {stacks.map((stack) => (
        <FolderCard
          key={stack.id}
          stack={stack}
          isActive={activeStackId === stack.id}
          onOpen={onSelect}
        />
      ))}

      {showCreateModal && (
        <FolderCreateModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(stackId) => onSelect(stackId)}
        />
      )}
    </div>
  );
}
