import { invoke } from '@tauri-apps/api/core';
import { startDrag } from '@crabnebula/tauri-plugin-drag';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useStackDropZoneStore } from '../stores/stackDropZoneStore';

let cachedIcon: string | null = null;
const cachedPackIcons = new Map<string, string>();

async function getIcon(packRoot?: string | null): Promise<string> {
  if (packRoot) {
    const cached = cachedPackIcons.get(packRoot);
    if (cached) return cached;
    const icon = await invoke<string>('get_drag_icon_for_pack', { packRoot });
    cachedPackIcons.set(packRoot, icon);
    return icon;
  }
  if (cachedIcon) return cachedIcon;
  cachedIcon = await invoke<string>('get_drag_icon');
  return cachedIcon;
}


/**
 * Converts the cursor position the drag plugin reports into viewport (CSS px)
 * coordinates, which is the space `getBoundingClientRect()` works in.
 *
 * The plugin reports a *logical* screen position on macOS but a physical one
 * on Windows — its own docs call that out, since Win32 has no trivial logical
 * position across monitors with different scaling. `innerPosition()` is
 * physical on both.
 */
async function makeViewportMapper(): Promise<
  ((x: number, y: number) => { x: number; y: number }) | null
> {
  try {
    const win = getCurrentWindow();
    const [pos, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
    const cursorIsPhysical = /Windows|Win32|Win64/i.test(navigator.userAgent);
    if (cursorIsPhysical) {
      return (x, y) => ({ x: (x - pos.x) / scale, y: (y - pos.y) / scale });
    }
    return (x, y) => ({ x: x - pos.x / scale, y: y - pos.y / scale });
  } catch {
    return null;
  }
}

export const dragService = {
  /**
   * Starts a native OS drag-out with the given file paths. The drop target
   * (Finder, FL Studio, Ableton, any DAW) receives real file references, so
   * the DAW imports the sample / MIDI / preset as if the user dragged from
   * Finder.
   *
   * Dropping back onto our own window is handled here, from the plugin's
   * completion callback. Tauri's window-level `onDragDropEvent` is not an
   * option for this: it reports drags arriving from other applications, and a
   * drag this window started and dropped on itself never reaches it — which
   * is why dropping a sample on a favourites folder used to do nothing.
   */
  async startFileDrag(paths: string[], opts?: { packRoot?: string | null }): Promise<void> {
    if (paths.length === 0) return;
    const icon = await getIcon(opts?.packRoot).catch(() => '');

    // Resolved before the drag so the callback stays synchronous. The
    // callback reports the cursor in screen coordinates (macOS flips Y to a
    // top-left origin inside the plugin); drop zones are measured with
    // getBoundingClientRect, which is viewport-relative.
    const toViewport = await makeViewportMapper();

    await startDrag({ item: paths, icon, mode: 'copy' }, (payload) => {
      const store = useStackDropZoneStore.getState();
      const assets = store.draggingAssets;
      store.setDraggingAssets([]);

      if (payload.result !== 'Dropped' || assets.length === 0 || !toViewport) return;

      const p = toViewport(Number(payload.cursorPos.x), Number(payload.cursorPos.y));
      const zone = store.hitTest(p.x, p.y);
      if (zone) store.dropHandler?.(zone, assets);
    });
  },

  /**
   * Writes `bytes` to an exports folder via a Rust command and immediately
   * kicks off a native drag-out for that file — used by the sample editor to
   * hand the DAW the rendered result of the current edit.
   */
  async startExportDrag(filename: string, bytes: Uint8Array): Promise<void> {
    const path = await invoke<string>('save_export', {
      filename,
      bytes: Array.from(bytes),
    });
    const icon = await getIcon().catch(() => '');
    await startDrag({ item: [path], icon, mode: 'copy' });
  },
};
