#!/bin/bash
# Put the current data straight into the installed Mac app.
#
# The public release ships empty on purpose — friends load their own. This is
# the personal copy: your classes, plus the ALEKS work D2L can't see, baked in
# so the app just opens and works with nothing to connect.
#
# Much faster than a full electron-builder run: it swaps one file inside the
# existing app bundle and re-signs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="/Applications/Owl Hours.app"
ASAR="$APP/Contents/Resources/app.asar"
WORK=/tmp/owl-asar-patch

[ -d "$APP" ] || { echo "Owl Hours isn't in /Applications — install the .dmg first."; exit 1; }

echo "==> rebuilding"
python3 "$ROOT/build.py" >/dev/null
[ -f "$ROOT/private/desktop/index.html" ] || { echo "no personal build — is private/data.json there?"; exit 1; }

echo "==> closing the app"
osascript -e 'quit app "Owl Hours"' 2>/dev/null || true
sleep 2

echo "==> patching"
rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"
npm i @electron/asar --silent --no-audit --no-fund >/dev/null 2>&1
node -e "require('@electron/asar').extractAll(process.argv[1],'unpacked')" "$ASAR"

# Replace EVERY file we build, not just the page. The app runs its own copy of
# the scraper, so leaving a stale grabber-return.js means the app re-scrapes on
# launch with the old parser and immediately overwrites the corrected data.
cp "$ROOT/private/desktop/index.html" unpacked/app/index.html
for f in grabber-return.js d2l.js main.js preload.js; do
  cp "$ROOT/electron/$f" "unpacked/$f"
done
node -e "require('@electron/asar').createPackage('unpacked',process.argv[1])" "$ASAR"

# The app prefers whatever is in localStorage over the freshly baked data, so a
# stale store would hide this update entirely. Drop it and let the app reload.
echo "==> clearing the old stored copy"
rm -rf "$HOME/Library/Application Support/Owl Hours/Local Storage"

echo "==> re-signing"
# repacking breaks the signature; unsigned means macOS calls it damaged
codesign --force --deep --sign - "$APP" 2>/dev/null
codesign --verify --deep --strict "$APP" 2>/dev/null || { echo "signature failed"; exit 1; }
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

ITEMS=$(node -e "
const fs=require('fs');
const m=fs.readFileSync('$ROOT/private/desktop/index.html','utf8').match(/var DEFAULT_DATA = (\{.*?\});\nvar APP_VERSION/s);
const d=JSON.parse(m[1]);
console.log(d.courses.length+' classes, '+d.courses.reduce((a,c)=>a+c.items.length,0)+' items');
")
rm -rf "$WORK"
echo "==> done — $ITEMS"
echo "    open it from Applications."
