import { useQuery } from '@tanstack/react-query';
import { settingsService } from '../services/settingsService';

export const webAccessKey = ['web-access-info'] as const;

/**
 * Live state of the embedded HTTP server: whether it is listening, on which
 * port, and the URLs (token included) that reach it from here and from the LAN.
 *
 * Refetched by the Settings page whenever a web-access setting changes, since
 * the backend restarts the server in place.
 */
export function useWebAccess(enabled = true) {
  return useQuery({
    queryKey: webAccessKey,
    queryFn: () => settingsService.getWebAccessInfo(),
    enabled,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    // The server rebinds asynchronously after a settings change, so poll
    // briefly while it is meant to be up but hasn't reported a bound port yet.
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && d.enabled && !d.running ? 1500 : false;
    },
  });
}
