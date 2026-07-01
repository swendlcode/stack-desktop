import { useCallback, useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { getReleaseNotes, type ReleaseNotes } from '../data/changelog';

const LAST_SEEN_VERSION_KEY = 'stack:lastSeenVersion';
const ONBOARDING_SEEN_KEY = 'stack:onboardingSeen';

interface WhatsNewState {
  version: string;
  notes: ReleaseNotes;
}

/**
 * Shows the "What's New" modal once after an update — when the running app
 * version differs from the last version the user acknowledged and that
 * version has changelog notes. Skipped for brand-new users (the onboarding
 * flow covers their first launch); their version is recorded silently so the
 * modal only ever appears on a genuine *update*.
 */
export function useWhatsNew() {
  const [whatsNew, setWhatsNew] = useState<WhatsNewState | null>(null);

  useEffect(() => {
    let cancelled = false;
    getVersion()
      .then((version) => {
        if (cancelled) return;
        let lastSeen: string | null = null;
        let onboardingSeen = false;
        try {
          lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY);
          onboardingSeen = localStorage.getItem(ONBOARDING_SEEN_KEY) === 'true';
        } catch {}

        const notes = getReleaseNotes(version);
        const isUpdate = onboardingSeen && lastSeen !== version && notes !== null;

        if (isUpdate && notes) {
          setWhatsNew({ version, notes });
        } else {
          // Brand-new user, or already up to date — record silently.
          try { localStorage.setItem(LAST_SEEN_VERSION_KEY, version); } catch {}
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const dismiss = useCallback(() => {
    setWhatsNew((cur) => {
      if (cur) {
        try { localStorage.setItem(LAST_SEEN_VERSION_KEY, cur.version); } catch {}
      }
      return null;
    });
  }, []);

  return { whatsNew, dismiss };
}
