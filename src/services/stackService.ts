import { invoke } from '@tauri-apps/api/core';
import type { Asset, Stack } from '../types';

export const stackService = {
  listStacks(): Promise<Stack[]> {
    return invoke('list_stacks');
  },

  createStack(name: string): Promise<Stack> {
    return invoke('create_stack', { name });
  },

  renameStack(id: string, name: string): Promise<void> {
    return invoke('rename_stack', { id, name });
  },

  setStackColor(id: string, color: string): Promise<void> {
    return invoke('set_stack_color', { id, color });
  },

  deleteStack(id: string): Promise<void> {
    return invoke('delete_stack', { id });
  },

  addAssetToStack(stackId: string, assetId: string): Promise<void> {
    return invoke('add_asset_to_stack', { stackId, assetId });
  },

  removeAssetFromStack(stackId: string, assetId: string): Promise<void> {
    return invoke('remove_asset_from_stack', { stackId, assetId });
  },

  getStackAssets(id: string, limit = 500, offset = 0): Promise<Asset[]> {
    return invoke('get_stack_assets', { id, limit, offset });
  },
};
