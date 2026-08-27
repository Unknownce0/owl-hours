# Keeping every device up to date

Two mechanisms, and you probably want both.

## On Mac and Windows: the app signs in itself

The desktop app keeps its own D2L session, separate from your browser.

1. Open Owl Hours → **Sign in to D2L** (or **Refresh** in the toolbar).
2. A real Kennesaw sign-in window opens. Sign in normally, MFA and all.
3. That's it. From then on the app re-checks D2L when it launches and every six hours,
   with no window and no interaction.

When Kennesaw eventually expires the session, the app quietly gives up rather than
ambushing you with a login window — press **Refresh** and sign in again.

**Forget my D2L sign-in** in the Sync tab clears the stored session. Use it on a shared
computer.

Your D2L password is never seen, stored, or handled by Owl Hours. The sign-in happens in
an ordinary browser window pointed at Kennesaw's own login page; the app only keeps the
resulting session cookie, exactly as a browser would.

## On the iPhone: pull from a sync URL

Phones can't run the desktop app, so they read the data instead.

**One-time setup** (needs the GitHub CLI):

    brew install gh && gh auth login
    node src/publish-sync.js

That encrypts your coursework and puts it in a secret gist, then prints a URL ending in
`#k=…`. Paste that whole URL into **Sync across your devices** in the app on each device
and tick **Check on every open**.

Your 7am task re-publishes to the same gist every morning, so every device is current
without you doing anything.

### About the encryption

The gist holds ciphertext only — AES-256-GCM. The key lives in the URL's `#k=` fragment,
and browsers never send fragments to servers, so GitHub stores something it cannot read.
Anyone who finds the gist without the key sees noise.

That does mean **the URL is the secret**. Treat it like a password: don't post it, and
don't paste it into a chat. If it leaks, run `node src/publish-sync.js --rotate` to make a
new key, then re-enter the new URL on your devices.

The key is stored in `private/sync-state.json`, which is gitignored and chmod 600. Losing
that file means rotating and re-entering the URL everywhere — nothing worse.

## If you'd rather not use GitHub

Any URL that returns the JSON works, as long as it allows cross-origin reads. Plain
unencrypted JSON is accepted too — the app only decrypts when the payload says
`"alg":"AES-GCM"`. Just remember an unencrypted file is readable by anyone with the link.
