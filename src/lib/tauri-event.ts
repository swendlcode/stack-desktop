// Transport shim for `@tauri-apps/api/event`.
//
// Vite aliases `@tauri-apps/api/event` to this module, so existing
// `import { listen, emit } from '@tauri-apps/api/event'` calls route through here.
//
// Desktop: real Tauri event bus. Browser: a single Server-Sent Events stream
// (`/__events`) that the desktop process bridges every `stack://…` emit onto.
import { event } from '@tauri-apps/api';
import { isTauri } from './tauri-core';

type BridgedEvent<T> = { event: string; payload: T; id: number };

let source: EventSource | null = null;
const handlers = new Map<string, Set<(e: BridgedEvent<unknown>) => void>>();

function ensureSource(): void {
  if (source || isTauri) return;
  source = new EventSource('/__events');
  source.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data) as { event: string; payload: unknown };
      const set = handlers.get(data.event);
      if (!set) return;
      const e: BridgedEvent<unknown> = {
        event: data.event,
        payload: data.payload,
        id: 0,
      };
      set.forEach((h) => h(e));
    } catch {
      /* ignore malformed frame */
    }
  };
  // EventSource reconnects automatically on error; nothing to do here.
}

export function listen<T>(
  eventName: string,
  handler: (e: BridgedEvent<T>) => void,
): Promise<() => void> {
  if (isTauri) {
    return event.listen<T>(eventName, handler as never) as Promise<() => void>;
  }
  ensureSource();
  let set = handlers.get(eventName);
  if (!set) {
    set = new Set();
    handlers.set(eventName, set);
  }
  const fn = handler as (e: BridgedEvent<unknown>) => void;
  set.add(fn);
  return Promise.resolve(() => {
    set!.delete(fn);
  });
}

export function emit(eventName: string, payload?: unknown): Promise<void> {
  // Frontend-originated emits only drive desktop-native side effects
  // (e.g. the macOS menu). Safe to no-op in the browser.
  return isTauri ? event.emit(eventName, payload) : Promise.resolve();
}
