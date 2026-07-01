import { useEffect } from 'react';
import type { ReleaseNotes } from '../data/changelog';
import { CloseCircle, TickCircle } from './ui/icons';
import { LogoMark } from './ui/LogoMark';

interface WhatsNewModalProps {
  version: string;
  notes: ReleaseNotes;
  onClose: () => void;
}

/** Shown once after updating to a version that has changelog notes. */
export function WhatsNewModal({ version, notes, onClose }: WhatsNewModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="What's new"
    >
      <div
        className="w-[min(480px,94vw)] overflow-hidden rounded-lg border border-gray-700 bg-stack-black shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="relative flex items-center gap-3 border-b border-gray-700/70 px-5 py-4">
          <LogoMark size={28} />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-stack-fire">
              What's new · v{version}
            </div>
            <h2 className="truncate text-base font-bold text-stack-white">{notes.title}</h2>
          </div>
          <button
            onClick={onClose}
            className="absolute right-3 top-3 rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-stack-white"
            aria-label="Close"
            title="Close (Esc)"
          >
            <CloseCircle size={18} color="currentColor" variant="Linear" />
          </button>
        </header>

        <div className="flex flex-col gap-4 p-5">
          {notes.summary && (
            <p className="text-sm leading-relaxed text-gray-400">{notes.summary}</p>
          )}
          <ul className="flex flex-col gap-2.5">
            {notes.highlights.map((item, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-gray-200">
                <span className="mt-0.5 shrink-0 text-stack-fire">
                  <TickCircle size={16} color="currentColor" variant="Bold" />
                </span>
                <span className="leading-snug">{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <footer className="flex justify-end border-t border-gray-700/70 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md bg-stack-fire px-4 py-1.5 text-xs font-semibold text-stack-black hover:bg-stack-fire/90"
          >
            Got it
          </button>
        </footer>
      </div>
    </div>
  );
}
