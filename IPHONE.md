# Loading your classes on an iPhone

Bookmarklets are painful on iOS, so use a Shortcut instead. Everything runs on your
phone; nothing is uploaded anywhere.

## Build the Shortcut (once, ~3 minutes)

1. Open **Shortcuts** → **+** to create a new one.
2. Add the action **Run JavaScript on Web Page**.
3. Tap the script area and replace the placeholder with the whole contents of
   [`grabber-ios-shortcut.js`](grabber-ios-shortcut.js).
   Easiest route: open that file in Safari on your phone, select all, copy, paste.
4. Add the action **Copy to Clipboard** underneath it.
5. Tap the **ⓘ** (Details) at the bottom and turn on **Show in Share Sheet**.
   Under *Share Sheet Types*, leave only **Safari web pages** ticked.
6. Name it **Grab my D2L** and save.

## Use it

1. In **Safari**, sign in to `kennesaw.view.usg.edu` and open your D2L homepage.
2. Tap **Share** → scroll down → **Grab my D2L**. Give it a few seconds.
3. Open Owl Hours → **Sync D2L** → paste into the box → **Load my classes**.

The first run asks permission to read the page — that's iOS confirming the script may
see D2L. Allow it.

## If something goes wrong

- **The Shortcut doesn't appear in the Share sheet** — it only shows on Safari *web
  pages*, not in other apps, and only if "Show in Share Sheet" is on.
- **You get `ERROR: open your D2L page first`** — you ran it on a different site.
  It only works on a `*.view.usg.edu` page.
- **You get `ERROR: no courses found`** — your D2L session expired. Sign in again in
  Safari and retry.
- **Nothing pastes** — the Shortcut needs the **Copy to Clipboard** action after the
  JavaScript one. Without it the result is computed and thrown away.

## Keeping it in step with your computer

Data lives per-device, so loading on your laptop does nothing for your phone. Either run
the Shortcut on the phone too, or put your data at a web address both can reach and enter
it under **Sync across your devices** in the app.

If you're on a Mac, Universal Clipboard also works: copy on the Mac, paste on the iPhone.
