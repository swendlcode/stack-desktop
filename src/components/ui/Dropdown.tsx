import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown2 } from './icons';

interface DropdownProps {
  /** The trigger button label */
  label: ReactNode;
  /** Whether any filter inside is active — highlights the trigger */
  active?: boolean;
  /**
   * The panel's contents. A function receives `close`, for a panel whose own
   * controls finish the job — anything with an Apply button, or a field where
   * Enter means "that's my answer". Without it the panel can only be
   * dismissed by clicking away from it, which reads as the button having
   * done nothing.
   */
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Min-width of the panel in px */
  minWidth?: number;
  /** Alignment of the dropdown panel */
  align?: 'left' | 'right';
}

/**
 * Generic dropdown panel. Renders the panel in a portal so it floats above
 * everything. Closes on outside click or Escape.
 */
export function Dropdown({
  label,
  active = false,
  children,
  minWidth = 240,
  align = 'left',
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const reposition = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    
    let left = r.left;
    if (align === 'right') {
      left = r.right - minWidth;
      // Ensure it doesn't go off the left edge of the screen
      left = Math.max(8, left);
    }
    
    // Ensure it doesn't go off the right edge of the screen
    const maxLeft = window.innerWidth - minWidth - 8;
    left = Math.min(left, maxLeft);
    
    setPos({ top: r.bottom + 6, left });
  }, [align, minWidth]);

  const toggle = () => {
    if (!open) reposition();
    setOpen((o) => !o);
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Reposition on scroll/resize
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggle}
        // 40px tall below `md` so the trigger is thumb-sized; the desktop
        // 32px chip is untouched from `md` up.
        className={`flex h-10 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-xs font-medium transition-colors md:h-8 ${
          active || open
            ? 'border-stack-fire bg-stack-fire/10 text-stack-fire'
            : 'border-gray-600 bg-transparent text-gray-300 hover:border-gray-500 hover:bg-gray-800 hover:text-stack-white'
        }`}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {label}
        <ArrowDown2
          size={11}
          color="currentColor"
          variant="Linear"
          style={{
            transition: 'transform 150ms',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              top: pos.top,
              left: pos.left,
              minWidth,
              // Never let a panel wider than the phone push the page sideways.
              maxWidth: 'calc(100vw - 16px)',
            }}
            className="fixed z-50 rounded-xl border border-gray-700 bg-gray-900 shadow-2xl shadow-black/40"
          >
            {typeof children === 'function' ? children(() => setOpen(false)) : children}
          </div>,
          document.body
        )}
    </>
  );
}

/** Reusable section header inside a dropdown panel */
export function DropdownSection({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="px-3 py-3">
      {title && (
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

/** Clears whatever the panel filters. Always the left-hand action. */
export function DropdownClear({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg px-3 py-1.5 text-sm text-gray-400 transition-colors hover:bg-gray-700 hover:text-stack-white"
    >
      Clear
    </button>
  );
}

/**
 * Dismisses the panel. Always the right-hand action, and deliberately not
 * styled as an accent button: it commits nothing. These panels apply as you
 * click, so this only puts the list back in view.
 */
export function DropdownClose({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:border-gray-500 hover:bg-gray-800 hover:text-stack-white"
    >
      Close
    </button>
  );
}

/** Divider between sections */
export function DropdownDivider() {
  return <div className="h-px bg-gray-700/80" />;
}

/**
 * Row of action buttons at the bottom of a dropdown.
 *
 * Two sides, not one. Clearing a filter and dismissing the panel are opposite
 * intentions and had been sitting next to each other on the right, where the
 * only button present — "Clear" — was in the position the eye reads as "done
 * here". Undoing your own filter is the last thing that should be under the
 * cursor at the moment you want to close.
 */
export function DropdownActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-gray-700 px-3 py-2">
      {children}
    </div>
  );
}
