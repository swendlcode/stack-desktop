import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Input } from '../ui/Input';
import { SearchNormal, CloseCircle } from '../ui/icons';
import { useSearchSuggestions } from '../../hooks/useSearchSuggestions';

interface SmartSearchProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  id?: string;
}

/**
 * Search box with a suggestion popover: the library's most common terms on an
 * empty box, prefix completions while typing, and nearest-match corrections
 * when a word matches nothing.
 */
export function SmartSearch({
  value,
  onChange,
  className = '',
  placeholder = 'Search samples, packs, instruments…',
  id,
}: SmartSearchProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The box updates instantly; only the suggestion fetch is throttled, so
  // typing does not fire one IPC round-trip per character.
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 150);
    return () => clearTimeout(t);
  }, [value]);

  const { data } = useSearchSuggestions(debounced, open);

  // Completions replace the word being typed; corrections and popular terms
  // replace the whole query.
  const items = useMemo(() => {
    if (!data) return [] as Array<{ label: string; apply: string; kind: string }>;
    const words = value.trim().split(/\s+/).filter(Boolean);
    const head = words.slice(0, -1).join(' ');
    const withHead = (term: string) => (head ? `${head} ${term}` : term);

    if (!value.trim()) {
      return data.popular.map((t) => ({ label: t, apply: t, kind: 'popular' }));
    }
    const completions = data.completions.map((t) => ({
      label: t,
      apply: withHead(t),
      kind: 'completion',
    }));
    const corrections = data.corrections.map((t) => ({
      label: t,
      apply: withHead(t),
      kind: 'correction',
    }));
    return [...corrections, ...completions];
  }, [data, value]);

  const reposition = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 6, left: rect.left, width: rect.width });
  };

  useEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [open]);

  useEffect(() => setHighlight(-1), [value]);

  const choose = (apply: string) => {
    onChange(apply);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open || items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? items.length - 1 : h - 1));
    } else if (e.key === 'Enter' && highlight >= 0) {
      e.preventDefault();
      choose(items[highlight].apply);
    }
  };

  const showPanel = open && items.length > 0;

  return (
    <>
      <div ref={wrapRef} className={className}>
        <Input
          id={id}
          className="w-full"
          placeholder={placeholder}
          value={value}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          leading={<SearchNormal size={15} color="var(--color-text-muted)" variant="Linear" />}
          trailing={
            value ? (
              <button
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
                aria-label="Clear search"
                className="-mr-1.5 flex h-9 w-9 shrink-0 items-center justify-center text-gray-400 transition-colors hover:text-stack-white md:mr-0 md:h-auto md:w-auto"
              >
                <CloseCircle size={15} color="currentColor" variant="Linear" />
              </button>
            ) : null
          }
        />
      </div>

      {showPanel &&
        createPortal(
          <div
            ref={panelRef}
            style={{ top: pos.top, left: pos.left, width: pos.width }}
            className="fixed z-[60] overflow-hidden rounded-xl border border-gray-700 bg-gray-900 py-1 shadow-2xl shadow-black/50"
          >
            {!value.trim() && (
              <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-widest text-gray-500">
                Popular in your library
              </div>
            )}
            {items.map((item, i) => (
              <button
                key={`${item.kind}-${item.label}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(item.apply)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                  highlight === i ? 'bg-gray-800 text-stack-white' : 'text-gray-300'
                }`}
              >
                <SearchNormal size={13} color="currentColor" variant="Linear" />
                <span className="truncate">{item.label}</span>
                {item.kind === 'correction' && (
                  <span className="ml-auto shrink-0 text-[10px] uppercase tracking-widest text-stack-fire">
                    did you mean
                  </span>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
