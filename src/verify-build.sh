#!/bin/bash
# Confirm the packaged app actually contains everything main.js requires.
# electron-builder's "files" list is an allowlist: adding a source file without
# adding it here produces an installer that crashes on launch.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASAR="$ROOT/dist/mac-arm64/Owl Hours.app/Contents/Resources/app.asar"
OUT=/tmp/owl-verify-$$
FAIL=0

[ -f "$ASAR" ] || { echo "no packaged app at $ASAR"; exit 1; }
rm -rf "$OUT"
# electron-builder ships the library as @electron/asar; call its API directly
# rather than guessing where a CLI shim lives.
( cd "$ROOT/electron" && node -e '
  const asar = require("@electron/asar");
  asar.extractAll(process.argv[1], process.argv[2]);
' "$ASAR" "$OUT" ) 2>/dev/null \
  || { echo "could not extract app.asar"; exit 1; }

check() {
  if [ -e "$OUT/$1" ]; then echo "  ok       $1"; else echo "  MISSING  $1"; FAIL=1; fi
}
contains() {
  if grep -q "$2" "$OUT/$1" 2>/dev/null; then echo "  ok       $1 contains \"$2\""
  else echo "  MISSING  $1 contains \"$2\""; FAIL=1; fi
}

echo "packaged contents:"
check main.js
check preload.js
check d2l.js
check grabber-return.js
check app/index.html
check build/icon.png

echo "behaviour:"
contains d2l.js "executeJavaScriptInIsolatedWorld"
contains d2l.js "bounced to single sign-on"
contains app/index.html "Refresh from D2L"

echo "privacy:"
if grep -q "DEFAULT_DATA = null" "$OUT/app/index.html" 2>/dev/null; then
  echo "  ok       ships with no coursework"
else
  echo "  FAIL     coursework may be baked into the app"; FAIL=1
fi

# every local require() in main.js must be present in the package
echo "requires resolve:"
grep -oE "require\('\./[a-zA-Z0-9_-]+'\)" "$OUT/main.js" 2>/dev/null | sed "s/require('\.\///;s/')//" | while read -r mod; do
  if [ -e "$OUT/$mod.js" ]; then echo "  ok       ./$mod"; else echo "  MISSING  ./$mod"; fi
done
grep -oE "require\('\./[a-zA-Z0-9_-]+'\)" "$OUT/main.js" 2>/dev/null | sed "s/require('\.\///;s/')//" | while read -r mod; do
  [ -e "$OUT/$mod.js" ] || exit 1
done || FAIL=1

rm -rf "$OUT"
echo
if [ "$FAIL" -eq 0 ]; then echo "BUILD OK"; else echo "BUILD INCOMPLETE — do not ship"; fi
exit $FAIL
