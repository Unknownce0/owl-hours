#!/bin/bash
# Rebuild, check, push, and publish downloads.
#
#   ./src/release.sh            push code + site changes only
#   ./src/release.sh v1.0.1     also rebuild the installers and publish a release
#
# GitHub Pages redeploys itself on push, so the web app updates with no extra step.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="${1:-}"

command -v gh >/dev/null || { echo "need the GitHub CLI: brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "not signed in: gh auth login"; exit 1; }

if [ -n "$VERSION" ]; then
  # One source of truth for the version; build.py stamps it into the app and
  # the service worker cache name, and the update banner compares against it.
  NUM="${VERSION#v}"
  node -e '
    const fs=require("fs"), p="electron/package.json";
    const d=JSON.parse(fs.readFileSync(p,"utf8"));
    d.version=process.argv[1];
    fs.writeFileSync(p, JSON.stringify(d,null,2)+"\n");
  ' "$NUM"
  echo "==> version set to $NUM"
fi

echo "==> rebuilding the app"
python3 build.py
node src/make_grabbers.js

if [ -n "$VERSION" ]; then
  # The toolchain gets deleted between releases to reclaim ~540MB, so install it
  # here rather than failing at packaging — after the version bump and push have
  # already happened, which leaves a tagged commit with no release attached.
  if [ ! -d electron/node_modules/electron/dist ]; then
    echo "==> installing the build toolchain (~540MB, one time)"
    ( cd electron && npm install --no-audit --no-fund --silent )
  fi
  # Packaging the Windows exe stamps it via Wine, which is Intel-only and so
  # needs Rosetta. Without it the whole run aborts and takes the Mac build with
  # it, so build only what this machine can actually produce.
  TARGETS="--mac"
  if arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
    TARGETS="--mac --win"
  else
    echo "!!  Rosetta is not installed, so the Windows build is being skipped."
    echo "    Windows users stay on the previous release until it is available."
    echo "    To enable it:  softwareupdate --install-rosetta --agree-to-license"
  fi
  # electron-builder mounts a disk image to build each DMG, and "hdiutil detach"
  # has now failed three releases because something else still held the volume
  # (Spotlight indexing it is the usual culprit). Adding the zip targets the
  # auto-updater needs doubled that work and made it hit most runs. Clear any
  # leftover volume first, and treat one failure as the flake it is.
  detach_stale() {
    for v in /Volumes/"Owl Hours"*; do
      [ -d "$v" ] && hdiutil detach -force "$v" >/dev/null 2>&1
    done
    return 0
  }

  echo "==> building installers (a few minutes)"
  detach_stale
  if ! ( cd electron && npx electron-builder $TARGETS ); then
    echo "!!  build failed — clearing stale disk images and retrying once"
    detach_stale
    sleep 5
    ( cd electron && npx electron-builder $TARGETS )
  fi
  echo "==> checking the package is complete"
  ./src/verify-build.sh || { echo "build incomplete, nothing published"; exit 1; }
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  git commit -q -m "${VERSION:-Update} $(date '+%Y-%m-%d')"
  echo "==> committed"
fi

echo "==> pushing"
git push -q origin HEAD
echo "    site will redeploy in a minute or two"

if [ -n "$VERSION" ]; then
  echo "==> publishing downloads as $VERSION"
  # Match this version only. Globbing all of dist/ attached every previous
  # build to the new release, so the download page listed six installers and
  # no obvious right one.
  # The installers, plus what the auto-updater needs: the macOS .zip Squirrel
  # updates from, and the latest*.yml feeds electron-builder writes. Without
  # the yml files the app can see a release but never work out what to fetch.
  FILES=()
  for f in dist/*"$NUM"*.dmg dist/*"$NUM"*.exe dist/*"$NUM"*.zip \
           dist/latest.yml dist/latest-mac.yml \
           dist/*"$NUM"*.blockmap; do
    [ -e "$f" ] && FILES+=("$f")
  done
  [ ${#FILES[@]} -gt 0 ] || { echo "no installers for $NUM in dist/"; exit 1; }
  echo "    attaching: ${FILES[*]##*/}"

  if gh release view "$VERSION" >/dev/null 2>&1; then
    gh release upload "$VERSION" "${FILES[@]}" --clobber
  else
    gh release create "$VERSION" "${FILES[@]}" \
      --title "Owl Hours $VERSION" \
      --notes "Download the file for your computer.

- **Mac (Apple Silicon)** — \`Owl-Hours-*-arm64.dmg\`
- **Mac (Intel)** — \`Owl-Hours-*-x64.dmg\`
- **Windows** — \`Owl-Hours-Windows-*-Setup.exe\`

These are unsigned, so the first launch needs a nudge: on macOS right-click the app and choose **Open**; on Windows click **More info → Run anyway**.

You can also just use it in a browser and install it from there — no download needed."
  fi
  echo "    $(gh release view "$VERSION" --json url -q .url)"
fi

echo "==> done"
