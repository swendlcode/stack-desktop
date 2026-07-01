import changelog from './changelog.json';

export interface ReleaseNotes {
  date: string;
  title: string;
  summary: string;
  highlights: string[];
}

/**
 * Version → release notes. This JSON is the single source of truth: the
 * in-app "What's New" modal reads it, and the GitHub release workflow
 * (.github/workflows/release.yml) extracts the same entry for the release
 * body. Add a new top entry whenever you cut a version.
 */
const RELEASES = changelog as Record<string, ReleaseNotes>;

export function getReleaseNotes(version: string): ReleaseNotes | null {
  return RELEASES[version] ?? null;
}
