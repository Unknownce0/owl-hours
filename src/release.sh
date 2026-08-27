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

echo "==> rebuilding the app"
python3 build.py
node src/make_grabbers.js

if [ -n "$VERSION" ]; then
  echo "==> building installers (a few minutes)"
  ( cd electron && npx electron-builder --mac --win )
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
  FILES=()
  for f in dist/*.dmg dist/*.exe; do [ -e "$f" ] && FILES+=("$f"); done
  [ ${#FILES[@]} -gt 0 ] || { echo "no installers in dist/"; exit 1; }

  if gh release view "$VERSION" >/dev/null 2>&1; then
    gh release upload "$VERSION" "${FILES[@]}" --clobber
  else
    gh release create "$VERSION" "${FILES[@]}" \
      --title "Owl Hours $VERSION" \
      --notes "Download the file for your computer.

- **Mac (Apple Silicon)** — \`Owl Hours-*-arm64.dmg\`
- **Mac (Intel)** — \`Owl Hours-*.dmg\` (no arm64 in the name)
- **Windows** — \`Owl-Hours-Windows.exe\`

These are unsigned, so the first launch needs a nudge: on macOS right-click the app and choose **Open**; on Windows click **More info → Run anyway**.

You can also just use it in a browser and install it from there — no download needed."
  fi
  echo "    $(gh release view "$VERSION" --json url -q .url)"
fi

echo "==> done"
