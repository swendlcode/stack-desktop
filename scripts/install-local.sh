#!/usr/bin/env bash
#
# Build this app and install it over /Applications, leaving exactly ONE copy of
# it on the machine.
#
# Duplicates had two separate sources, and both are handled here.
#
#   1. The build output is a real app. `target/release/bundle/macos/<App>.app`
#      is a launchable bundle, so Spotlight indexed it and Launchpad offered it
#      next to the installed one — that is where the three Keystones and four
#      Capstones came from, and why they came back after every clean build. The
#      `.metadata_never_index` marker this script keeps in `target/` takes the
#      whole build tree out of the index, and the bundle is removed once it has
#      been installed so no stale copy can outlive the build that made it.
#
#   2. The staging directory. Installing by `ditto`ing to `<App>.app.incoming`
#      and then swapping leaves that staged bundle sitting in /Applications as
#      a second app if anything fails in between. It is staged outside
#      /Applications here, and cleaned up on any exit.
#
# The previous version is moved to the Trash under a name that does NOT end in
# `.app`, so Launch Services does not keep offering it from there either.
#
set -euo pipefail

APP_NAME="Stack"
BUNDLE_ID="app.stack.desktop"

cd "$(dirname "$0")/.."
PROJECT="$PWD"
TARGET="$PROJECT/src-tauri/target"
BUILT="$TARGET/release/bundle/macos/$APP_NAME.app"
DEST="/Applications/$APP_NAME.app"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/$APP_NAME-install.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# Keep the build tree out of Spotlight before anything is written into it.
mkdir -p "$TARGET"
touch "$TARGET/.metadata_never_index"

if [ "${1:-}" != "--no-build" ]; then
  echo ":: building $APP_NAME"
  # Updater artifacts are turned off for a local install: signing them needs
  # TAURI_SIGNING_PRIVATE_KEY, which lives only in CI, and without it the
  # build fails at the very last step with the bundle already written —
  # leaving exactly the stray copy this script exists to prevent.
  npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
fi

[ -d "$BUILT" ] || { echo "no bundle at $BUILT"; exit 1; }

VERSION="$(defaults read "$BUILT/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo unknown)"
echo ":: installing $APP_NAME $VERSION"

ditto "$BUILT" "$STAGE/$APP_NAME.app"

if [ -d "$DEST" ]; then
  OLD="$(defaults read "$DEST/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo unknown)"
  # No `.app` suffix: a bundle in the Trash with one still shows up in search.
  mv "$DEST" "$HOME/.Trash/$APP_NAME-$OLD-backup-$(date +%Y%m%d-%H%M%S)"
fi
mv "$STAGE/$APP_NAME.app" "$DEST"

# The installed copy is the only one that should exist. Remove the build output
# rather than trusting the Spotlight exclusion alone.
rm -rf "$BUILT"

echo ":: verifying"
COPIES="$(find /Applications -maxdepth 2 -name "$APP_NAME.app" -print 2>/dev/null | wc -l | tr -d ' ')"
STRAY="$(find "$PROJECT" -name "$APP_NAME.app" -maxdepth 7 -print 2>/dev/null || true)"
echo "   /Applications copies : $COPIES"
echo "   in the build tree    : ${STRAY:-none}"
[ "$COPIES" = "1" ] || { echo "!! expected exactly one installed copy"; exit 1; }
[ -z "$STRAY" ] || { echo "!! build tree still holds a bundle"; exit 1; }

echo "OK $APP_NAME $VERSION installed ($BUNDLE_ID), no duplicates"
