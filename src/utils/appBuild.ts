import buildMeta from '../data/build.json';

/**
 * Which build this is.
 *
 * The version number says what changed; the build number says which copy you
 * are running. They are not the same question. Several builds of 1.0.27 have
 * been installed over each other while a single bug was chased, and "are you
 * on the one with the fix?" could not be answered from anything on screen —
 * both copies called themselves 1.0.27.
 *
 * `scripts/install-local.sh` increments this before every build, so the
 * number is a count of builds that actually exist rather than something
 * anyone has to remember to bump.
 */
export const BUILD_NUMBER: number = buildMeta.build;

/** `1.0.27 (50)` — the version with the build it came from. */
export function versionLabel(version: string): string {
  if (!version) return '';
  return `${version} (${BUILD_NUMBER})`;
}
