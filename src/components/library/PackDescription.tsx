import { useEffect, useRef, useState } from 'react';
import {
  usePackDescription,
  useSetPackDescription,
} from '../../hooks/usePacks';

interface Props {
  packRoot: string | null;
  placeholder?: string;
}

export function PackDescription({
  packRoot,
  placeholder = 'Add a description for this pack…',
}: Props) {
  const { data: remote = '' } = usePackDescription(packRoot);
  const save = useSetPackDescription(packRoot);
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!dirtyRef.current) setValue(remote);
  }, [remote]);

  // The height always equals the content, so there is never anything to
  // scroll to — see `overflow-hidden` below. `scrollHeight` is an integer and
  // the real line box is fractional at any interface scale other than 100%,
  // so round up: a height one sub-pixel short is overflow, and overflow on a
  // field this shape is a scrollbar drawn across the only line of text.
  const autoresize = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.ceil(el.scrollHeight) + 1}px`;
  };

  useEffect(autoresize, [value]);

  const commit = () => {
    if (!dirtyRef.current) return;
    if (value === remote) {
      dirtyRef.current = false;
      return;
    }
    save.mutate(value, {
      onSuccess: () => {
        dirtyRef.current = false;
      },
    });
  };

  return (
    <textarea
      ref={taRef}
      value={value}
      onChange={(e) => {
        dirtyRef.current = true;
        setValue(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      placeholder={placeholder}
      disabled={!packRoot}
      rows={1}
      className="w-full resize-none overflow-hidden bg-transparent text-sm text-gray-300 placeholder:text-gray-600 focus:outline-none focus:ring-0"
    />
  );
}
