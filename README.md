# Owl Hours

Your Kennesaw State coursework in one place — what's due, when, and where you stand.

Pulls assignments, quizzes, discussions, and grades out of D2L/Brightspace and puts them
into one agenda, a month calendar, a per-class view, and a what-if grade calculator.
Installs as a real app on iPhone, Android, Mac, and Windows.

**Your coursework never leaves your device.** This site ships with no data in it at all.
You load your own classes with the grabber, and they live in your browser's local storage.
There's no account, no server, and no database.

## Install it

| Where | How |
|---|---|
| **iPhone / iPad** | Open in Safari → Share → **Add to Home Screen** |
| **Android** | Open in Chrome → **Install app** |
| **Mac** | Safari → File → **Add to Dock**, or Chrome → **Install** |
| **Windows** | Edge or Chrome → **Install this site as an app** |

Installed on a phone, it runs fullscreen and keeps its data indefinitely — unlike a plain
Safari tab, which discards site data after 7 days of not visiting.

There are also downloadable desktop builds under Releases if you'd rather have a `.dmg`
or `.exe`. They're unsigned, so the first launch needs a right-click → Open on macOS, or
"More info → Run anyway" on Windows.

## Load your classes

1. Open the app, go to **Sync D2L**, and save the grabber to your bookmarks bar.
   Safari can't do this by dragging — the app shows you the bookmark-editor route.
2. Sign in to `kennesaw.view.usg.edu`, click the bookmark, wait a few seconds.
3. Copy what it shows you, paste it back into the app.

To keep several devices in step, host the grabber's output somewhere both can reach and
put that address in **Sync across your devices**.

## Working on it

    python3 src/make_icons.py    # regenerate app icons (no dependencies)
    ./src/verify-build.sh        # check the packaged app is complete before shipping
    python3 build.py             # build index.html + the desktop app's copy
    cd electron && npm start     # run the desktop app
    cd electron && npm run dist  # build .dmg and .exe into ../dist

`src/app.tpl.html` is the only source file for the UI — everything else is generated.
Never edit `index.html` directly.

**If you add a file under `electron/`, add it to `build.files` in `electron/package.json`.**
That setting is an allowlist, not a filter: a missing entry produces an installer that
builds cleanly and then crashes on launch, because the `require()` has nothing to resolve.
`src/verify-build.sh` exists to catch exactly that — run it after every build.

## D2L notes

Per-course endpoints, where `ou` is the course id from `/d2l/lp/courseSelector/6629/InitPartial`:

    /d2l/home/<ou>                                          title + course code
    /d2l/lms/dropbox/user/folders_list.d2l?ou=<ou>&isprv=0   assignments
    /d2l/lms/quizzing/user/quizzes_list.d2l?ou=<ou>          quizzes
    /d2l/le/<ou>/discussions/List                            discussions
    /d2l/lms/grades/my_grades/main.d2l?ou=<ou>               grades

Four things that will silently return nothing if you don't know them:

- Quiz links have no `href`. The id is in `onclick="GoToQuiz(<id>)"`.
- Assignment rows have **no anchor at all** when access is restricted before the
  availability window opens. Take the name from the first cell's text and cut it at
  "Available on" / "Due on" / "Access restricted".
- The course code sits in an HTML-escaped attribute and does **not** survive
  `DOMParser` → `innerHTML`. Match it against the raw response text.
- Courses copied forward from a previous year keep the previous year's dates. The app
  flags anything dated outside the current term instead of calling it overdue.

Discussion topics carry no due dates — they're forums.

## Browser notes

- The grabber hands data over through an on-page panel with its own Copy button rather
  than calling `navigator.clipboard` directly. Safari drops the bookmarklet click's user
  activation across the ~30 awaited fetches, so a direct clipboard write always rejects;
  the panel's button is a fresh gesture and `document.execCommand('copy')` works there.
- Safari cannot install a bookmarklet by dragging, and refuses `javascript:` pasted into
  the address bar. It has to go in through Bookmarks → Edit Bookmarks → Edit Address.
- Safari also blocks bookmarklets started from the address bar, with *"Safari doesn't
  allow JavaScript from the Smart Search field."* That error means the bookmark is
  intact — it was just invoked from the wrong place. Click the button on the Favorites
  Bar directly, and turn on Settings → Advanced → "Show features for web developers",
  then Developer → "Allow JavaScript from Smart Search field".
