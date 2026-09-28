/* Scraping D2L from inside the app.
   The session lives in its own persistent partition, so signing in once keeps
   working across restarts and later refreshes need no interaction at all. */
const { BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

const HOME = 'https://kennesaw.view.usg.edu/d2l/home';
const PARTITION = 'persist:d2l';
const SCRAPER = fs.readFileSync(path.join(__dirname, 'grabber-return.js'), 'utf8');
const SCANNER = fs.readFileSync(path.join(__dirname, 'scan-page.js'), 'utf8');

const isD2L = (url) => /^https:\/\/[^/]*\.view\.usg\.edu\//.test(url);

function d2lSession() {
  return session.fromPartition(PARTITION);
}

/** Run the scraper in a loaded window. Isolated world so the page's CSP can't block it. */
async function runScraper(wc) {
  let raw;
  try {
    raw = await wc.executeJavaScriptInIsolatedWorld(1, [{ code: SCRAPER }]);
  } catch (e) {
    raw = await wc.executeJavaScript(SCRAPER, true);
  }
  if (typeof raw !== 'string') return { ok: false, error: 'unexpected result from D2L' };
  if (raw.startsWith('ERROR:NOAUTH')) return { ok: false, needLogin: true };
  // NOTD2L means we were bounced off D2L, which in practice is the SSO login page.
  if (raw.startsWith('ERROR:NOTD2L')) return { ok: false, needLogin: true };
  if (raw.startsWith('ERROR:')) return { ok: false, error: raw.slice(6) };
  try {
    const data = JSON.parse(raw);
    if (!data.courses || !data.courses.length) return { ok: false, needLogin: true };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: 'could not read what D2L returned' };
  }
}

function loadAndWait(win, url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    win.webContents.once('did-finish-load', done);
    win.webContents.once('did-fail-load', done);
    setTimeout(done, 30000);
    win.loadURL(url);
  });
}

/* A lapsed D2L session isn't necessarily a lapsed sign-in. D2L first serves a
   stub page that script-redirects to its login, which bounces through
   Kennesaw's Microsoft sign-in; if Microsoft still remembers the user
   ("Stay signed in"), it posts straight back to D2L with no input at all.
   So wait for the redirects to stop before deciding anything: settled means
   no navigation for a couple of seconds, or 25 seconds overall. */
function settle(win, quietMs = 2500, maxMs = 25000) {
  return new Promise((resolve) => {
    const wc = win.webContents;
    let quiet, finished = false;
    const finish = () => {
      if (finished) return; finished = true;
      clearTimeout(quiet); clearTimeout(cap);
      wc.removeListener('did-start-navigation', nav);
      wc.removeListener('did-finish-load', bump);
      resolve(wc.isDestroyed() ? '' : wc.getURL());
    };
    const bump = () => { clearTimeout(quiet); quiet = setTimeout(finish, quietMs); };
    const cap = setTimeout(finish, maxMs);
    // the dashboard's widgets load in frames; only the page itself counts
    const nav = (e, _url, _inPlace, isMain) => {
      if (isMain === false || (e && e.isMainFrame === false)) return;
      bump();
    };
    wc.on('did-start-navigation', nav);
    wc.on('did-finish-load', bump);
    bump();
  });
}

/* Signed in means a real D2L page, not the login stub or the SSO pages. */
const onD2LProper = (url) => isD2L(url) && /\/d2l\//.test(url) && !/\/d2l\/(login|lp\/auth\/)/i.test(url);

/**
 * @param {boolean} interactive  may we show a sign-in window?
 * @param {(s:string)=>void} say progress reporter
 */
async function grab(interactive, say = () => {}) {
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 780,
    title: 'Sign in to D2L',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      // deliberately no preload here: this window loads Kennesaw's real login page
      sandbox: true
    }
  });

  const close = () => { if (!win.isDestroyed()) win.destroy(); };

  try {
    say('Checking your D2L session…');
    await loadAndWait(win, HOME);
    const landed = await settle(win);

    let res;
    if (!onD2LProper(landed)) {
      res = { ok: false, needLogin: true };   // bounced to single sign-on
    } else {
      res = await runScraper(win.webContents);
    }
    if (res.ok) { close(); return res; }

    if (!res.needLogin) { close(); return res; }
    if (!interactive) { close(); return { ok: false, needLogin: true }; }

    // Session is gone or was never there — let them sign in, then retry.
    say('Sign in to D2L in the window that just opened.');
    win.show();
    win.focus();

    const signedIn = await new Promise((resolve) => {
      let finished = false;
      const finish = (v) => { if (!finished) { finished = true; resolve(v); } };

      const onNav = async (_e, url) => {
        if (!onD2LProper(url)) return;
        // give the dashboard a beat to settle before probing
        setTimeout(async () => {
          if (win.isDestroyed()) return finish(false);
          const probe = await runScraper(win.webContents);
          if (probe.ok) finish(probe);
        }, 1200);
      };

      win.webContents.on('did-navigate', onNav);
      win.webContents.on('did-navigate-in-page', onNav);
      win.on('closed', () => finish(false));
      setTimeout(() => finish(false), 5 * 60 * 1000);   // give up after 5 minutes
    });

    close();
    if (signedIn && signedIn.ok) return signedIn;
    return { ok: false, error: 'sign-in was not completed' };
  } catch (e) {
    close();
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/* The smart scanner: reads announcements and course pages for deadlines D2L
   never listed as real items. Silent only; it never opens a sign-in window. */
async function scan(orgUnits) {
  const ous = (orgUnits || []).map(String).filter((x) => /^\d+$/.test(x));
  if (!ous.length) return { ok: true, results: [], stats: {} };
  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  try {
    await loadAndWait(win, HOME);
    if (!onD2LProper(await settle(win))) return { ok: false, needLogin: true };
    const code = 'var OU_LIST = ' + JSON.stringify(ous) + ';\n' + SCANNER;
    const raw = await Promise.race([
      win.webContents.executeJavaScriptInIsolatedWorld(1, [{ code }]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('the scan took too long')), 120000))
    ]);
    const j = JSON.parse(raw);
    return { ok: true, results: j.results || [], stats: j.stats || {} };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function signOut() {
  await d2lSession().clearStorageData();
  return { ok: true };
}

/* Only sites Owl Hours reads may be forgotten one at a time. */
const FORGETTABLE = ['https://www.gradescope.com'];
async function forget(origin) {
  if (!FORGETTABLE.includes(origin)) return { ok: false, error: 'not a site Owl Hours reads' };
  await d2lSession().clearStorageData({ origin });
  return { ok: true };
}

module.exports = { grab, scan, signOut, forget };
