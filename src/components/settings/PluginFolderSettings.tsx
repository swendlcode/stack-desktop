import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Button } from '../ui/Button';
import { FolderAdd, Trash } from '../ui/icons';
import { loadCustomPluginPaths, saveCustomPluginPaths } from '../../utils/pluginPaths';

/**
 * Extra plugin folders beyond the standard system locations (which are always
 * scanned automatically). Persisted in localStorage and read by the Plugins page.
 */
export function PluginFolderSettings() {
  const [paths, setPaths] = useState<string[]>(loadCustomPluginPaths);

  const persist = (next: string[]) => {
    setPaths(next);
    saveCustomPluginPaths(next);
  };

  const addFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: true,
      title: 'Add Plugin Folders',
    });
    if (!selected) return;
    const folders = Array.isArray(selected) ? selected : [selected];
    if (folders.length === 0) return;
    persist(Array.from(new Set([...paths, ...folders])));
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      {paths.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-700 p-4 text-center text-xs text-gray-500">
          Standard system plugin folders are scanned automatically. Add a folder only if you
          keep plugins somewhere unusual.
        </div>
      ) : (
        paths.map((path) => (
          <div
            key={path}
            className="flex items-center justify-between gap-2 rounded-md border border-gray-700 bg-gray-800 px-3 py-2"
          >
            <div className="mono flex-1 truncate text-sm text-stack-white" title={path}>
              {path}
            </div>
            <button
              onClick={() => persist(paths.filter((p) => p !== path))}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-xs text-gray-400 transition-colors hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-300"
            >
              <Trash size={14} color="currentColor" variant="Linear" />
              Remove
            </button>
          </div>
        ))
      )}
      <div>
        <Button
          variant="ghost"
          size="sm"
          icon={<FolderAdd size={14} color="currentColor" variant="Linear" />}
          onClick={addFolder}
        >
          Add Plugin Folder
        </Button>
      </div>
    </div>
  );
}
