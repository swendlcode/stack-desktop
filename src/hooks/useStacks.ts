import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { stackService } from '../services/stackService';

export const stackQueryKeys = {
  all: ['stacks'] as const,
  assets: (id: string, limit: number, offset: number) =>
    [...stackQueryKeys.all, id, 'assets', limit, offset] as const,
};

export function useStacks() {
  return useQuery({
    queryKey: stackQueryKeys.all,
    queryFn: () => stackService.listStacks(),
  });
}

export function useStackAssets(id: string | null, limit: number, offset: number) {
  return useQuery({
    queryKey: id ? stackQueryKeys.assets(id, limit, offset) : ['stacks', 'null', 'assets'],
    queryFn: () => (id ? stackService.getStackAssets(id, limit, offset) : []),
    enabled: Boolean(id),
    placeholderData: (prev) => prev,
  });
}

export function useCreateStack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => stackService.createStack(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: stackQueryKeys.all }),
  });
}

export function useRenameStack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => stackService.renameStack(id, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: stackQueryKeys.all }),
  });
}

export function useSetStackColor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, color }: { id: string; color: string }) => stackService.setStackColor(id, color),
    onSuccess: () => qc.invalidateQueries({ queryKey: stackQueryKeys.all }),
  });
}

export function useDeleteStack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => stackService.deleteStack(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: stackQueryKeys.all }),
  });
}

export function useAddAssetToStack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ stackId, assetId }: { stackId: string; assetId: string }) =>
      stackService.addAssetToStack(stackId, assetId),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: stackQueryKeys.all });
      qc.invalidateQueries({ queryKey: [...stackQueryKeys.all, vars.stackId] });
    },
  });
}
