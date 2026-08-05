import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pluginService } from '../services/pluginService';

export const pluginQueryKeys = {
  all: ['plugins'] as const,
  scan: (extraPaths: string[]) => ['plugins', 'scan', extraPaths] as const,
  leftovers: (pluginPath: string | null) => ['plugins', 'leftovers', pluginPath] as const,
};

export function usePluginScan(extraPaths: string[]) {
  return useQuery({
    queryKey: pluginQueryKeys.scan(extraPaths),
    queryFn: () => pluginService.scanPlugins([], extraPaths),
    staleTime: 30_000,
  });
}

export function usePluginLeftovers(pluginPath: string | null, extraPaths: string[]) {
  return useQuery({
    queryKey: pluginQueryKeys.leftovers(pluginPath),
    queryFn: () =>
      pluginPath ? pluginService.findPluginLeftovers(pluginPath, extraPaths) : null,
    enabled: Boolean(pluginPath),
    // Always re-sweep when the delete modal opens — the disk may have changed.
    staleTime: 0,
    gcTime: 0,
  });
}

export function useDeletePlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { paths: string[]; registryKeys: string[]; extraRoots: string[] }) =>
      pluginService.deletePlugin(input.paths, input.registryKeys, input.extraRoots),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pluginQueryKeys.all });
    },
  });
}
