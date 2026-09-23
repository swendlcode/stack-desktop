import { useQuery } from '@tanstack/react-query';
import { assetService } from '../services/assetService';

/**
 * Autocomplete / "did you mean" / popular terms for the search box. The
 * backend reads the library's own search vocabulary, so suggestions are
 * always words that actually appear in this user's files.
 */
export function useSearchSuggestions(query: string, enabled = true) {
  return useQuery({
    queryKey: ['search-suggestions', query],
    queryFn: () => assetService.getSearchSuggestions(query),
    enabled,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}
