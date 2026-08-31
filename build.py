#!/usr/bin/env python3
"""Build Owl Hours from src/app.tpl.html.

Three targets, one source:
  index.html                        the hosted PWA. Ships with NO coursework in it.
  private/owl-hours-artifact.html   the Claude artifact, with your snapshot baked in.
  electron/app/                     what the desktop apps load.

The template is an HTML fragment (the artifact host supplies <head>/<body>);
the PWA and Electron builds wrap it in a real document.
"""
import json, os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TPL  = os.path.join(HERE, "src", "app.tpl.html")
PLACEHOLDER = "/*__DATA__*/null"

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Your Kennesaw State coursework in one place.">
<meta name="theme-color" content="#14130F">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Owl Hours">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">
<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">
__MANIFEST__
<style>
  /* keep content clear of the notch / home indicator when installed */
  body { padding: env(safe-area-inset-top) env(safe-area-inset-right)
                  env(safe-area-inset-bottom) env(safe-area-inset-left); }
</style>
</head>
<body>
"""

TAIL = """
__SW__
</body>
</html>
"""

SW_REG = """<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline support is optional */ });
  });
}
</script>"""


VERSION_PLACEHOLDER = '/*__VERSION__*/"dev"'


def app_version():
    """Single source of truth for the version: electron/package.json."""
    pkg = os.path.join(HERE, "electron", "package.json")
    return json.load(open(pkg))["version"]


def render(data_json):
    tpl = open(TPL).read()
    if PLACEHOLDER not in tpl:
        sys.exit("refusing to build: template placeholder is missing")
    if VERSION_PLACEHOLDER not in tpl:
        sys.exit("refusing to build: version placeholder is missing")
    return (tpl.replace(PLACEHOLDER, data_json)
               .replace(VERSION_PLACEHOLDER, json.dumps(app_version())))


def merge_extras(parsed):
    """Fold in work D2L cannot see (ALEKS, and anything else added by hand).

    The daily scrape overwrites private/data.json wholesale, so anything not in
    D2L has to live in its own file and be merged at build time or it would be
    silently lost every morning.
    """
    p = os.path.join(HERE, "private", "extra-items.json")
    if not os.path.exists(p):
        return 0
    extra = json.load(open(p))
    added = 0
    for course in parsed.get("courses", []):
        block = extra.get("courses", {}).get(course["id"])
        if not block:
            continue
        have = {i.get("n") for i in course.get("items", [])}
        for item in block.get("items", []):
            if item.get("n") not in have:
                course.setdefault("items", []).append(item)
                added += 1
    return added


def load_private_data():
    p = os.path.join(HERE, "private", "data.json")
    if not os.path.exists(p):
        return None
    raw = open(p).read().strip()
    parsed = json.loads(raw)
    if not parsed.get("courses"):
        sys.exit("refusing to build: private/data.json has no courses")
    added = merge_extras(parsed)
    if added:
        print("  merged %d item(s) from private/extra-items.json" % added)
        raw = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
    # What the sync publisher should send: D2L plus everything D2L can't see.
    open(os.path.join(HERE, "private", "data-merged.json"), "w").write(raw)
    return raw, parsed


def main():
    built = []

    # 1. hosted PWA — deliberately empty, because the repo is public
    body = render("null")
    html = (HEAD.replace("__MANIFEST__", '<link rel="manifest" href="manifest.json">')
            + body + TAIL.replace("__SW__", SW_REG))
    open(os.path.join(HERE, "index.html"), "w").write(html)
    built.append(("index.html (PWA, no data)", len(html)))

    # The cache name has to change per release, or the worker keeps serving
    # the old shell and nobody ever sees the update.
    sw_src = os.path.join(HERE, "sw.js")
    sw = open(sw_src).read()
    stamped = sw.replace("__VERSION__", app_version())
    if stamped != sw:
        open(sw_src, "w").write(stamped)
    elif "owl-hours-" + app_version() not in sw:
        import re as _re
        stamped = _re.sub(r"const CACHE = 'owl-hours-[^']*';",
                          "const CACHE = 'owl-hours-%s';" % app_version(), sw)
        open(sw_src, "w").write(stamped)
    built.append(("sw.js (cache owl-hours-%s)" % app_version(), len(stamped)))

    # 2. Electron loads the same document, minus the service worker
    appdir = os.path.join(HERE, "electron", "app")
    os.makedirs(appdir, exist_ok=True)
    desktop = HEAD.replace("__MANIFEST__", "") + body + TAIL.replace("__SW__", "")
    open(os.path.join(appdir, "index.html"), "w").write(desktop)
    icons_dst = os.path.join(appdir, "icons")
    if os.path.isdir(icons_dst):
        shutil.rmtree(icons_dst)
    shutil.copytree(os.path.join(HERE, "icons"), icons_dst)
    built.append(("electron/app/index.html", len(desktop)))

    # 2b. A personal desktop copy with the data already inside, so it works on
    #     open with nothing to connect. Never published; this is Kachi's machine.
    priv_for_desktop = load_private_data()
    if priv_for_desktop:
        raw_pd, parsed_pd = priv_for_desktop
        personal = (HEAD.replace("__MANIFEST__", "")
                    + render(raw_pd) + TAIL.replace("__SW__", ""))
        os.makedirs(os.path.join(HERE, "private", "desktop"), exist_ok=True)
        open(os.path.join(HERE, "private", "desktop", "index.html"), "w").write(personal)
        n = sum(len(c.get("items", [])) for c in parsed_pd["courses"])
        built.append(("private/desktop/index.html (personal, %d items)" % n, len(personal)))

    # 3. the Claude artifact keeps its baked-in snapshot (fragment, not a document)
    priv = load_private_data()
    if priv:
        raw, parsed = priv
        frag = render(raw)
        open(os.path.join(HERE, "private", "owl-hours-artifact.html"), "w").write(frag)
        n_items = sum(len(c.get("items", [])) for c in parsed["courses"])
        built.append(("private/owl-hours-artifact.html (%d courses, %d items)"
                      % (len(parsed["courses"]), n_items), len(frag)))
    else:
        print("  note: private/data.json absent — skipping the artifact build")

    print("  version %s" % app_version())
    for name, size in built:
        print("  %-58s %7d bytes" % (name, size))


if __name__ == "__main__":
    main()
