/* The hidden windows that read D2L, Gradescope and ALEKS, in one place.
 *
 * They all share one signed-in profile (persist:d2l) and load other people's
 * pages, so they get the same locks: no permission prompts (camera,
 * notifications, location…) and no pop-ups. Sign-in is the one exception that
 * was checked for: Microsoft, D2L, ALEKS and Gradescope all sign in by
 * redirecting the same window, but a visible sign-in window may still open
 * one of those sites in a new window (a "Learn more" or security-info page),
 * so only those hosts are let through, and only from a window the user can see.
 */
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:d2l';
const D2L = 'https://kennesaw.view.usg.edu';
const WHOAMI = D2L + '/d2l/api/lp/1.43/users/whoami';

const SIGN_IN_HOSTS = /(^|\.)(microsoftonline\.com|microsoft\.com|live\.com|view\.usg\.edu|aleks\.com|gradescope\.com)$/;
const debug = (...a) => { if (process.env.OWL_DEBUG) console.log('[owl]', ...a); };

let locked = false;
function lockSession() {
  if (locked) return;
  locked = true;
  const s = session.fromPartition(PARTITION);
  s.setPermissionRequestHandler((_wc, permission, cb) => { debug('denied permission', permission); cb(false); });
  s.setPermissionCheckHandler(() => false);
}

function guardPopups(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { /* not a real URL */ }
    if (win.isVisible() && SIGN_IN_HOSTS.test(host)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 900, height: 760,
          webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true }
        }
      };
    }
    debug('blocked pop-up', url);
    return { action: 'deny' };
  });
  // a pop-up that was let through gets the same rule
  win.webContents.on('did-create-window', (child) => guardPopups(child));
}

/** A window on the shared profile with the locks on. */
function open(opts = {}) {
  lockSession();
  const win = new BrowserWindow(Object.assign({ show: false, width: 1024, height: 780 }, opts, {
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true }
  }));
  guardPopups(win);
  return win;
}

/** Load a URL and wait for it, at most 30 seconds. */
function load(win, url, maxMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const wc = win.webContents;
    const done = () => {
      if (settled) return; settled = true;
      clearTimeout(t);
      wc.removeListener('did-finish-load', done);
      wc.removeListener('did-fail-load', done);
      resolve();
    };
    const t = setTimeout(done, maxMs);
    wc.once('did-finish-load', done);
    wc.once('did-fail-load', done);
    win.loadURL(url).catch(() => {});
  });
}

/* A signed-out /d2l/home is still a 200 page ON D2L (a stub that script-
   redirects to the login), so being on D2L proves nothing. whoami is a tiny
   JSON reply that names the user only when the session is real, and once
   loaded the window is on D2L's origin for same-origin API fetches. */
const WHOAMI_OK = "(function(){try{return !!JSON.parse(document.body.innerText).Identifier}catch(e){return false}})()";

/** Load whoami in this window; true only for a real D2L session. */
async function d2lSignedIn(win) {
  await load(win, WHOAMI);
  if (win.isDestroyed()) return false;
  if (!/^https:\/\/[^/]*\.view\.usg\.edu\//.test(win.webContents.getURL())) return false;
  return win.webContents.executeJavaScript(WHOAMI_OK, true).catch(() => false);
}

module.exports = { PARTITION, D2L, WHOAMI, open, load, d2lSignedIn, lockSession, guardPopups };
