const { app, BrowserWindow, shell, Menu, ipcMain, powerMonitor, Tray, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const d2l = require('./d2l');
const aleks = require('./aleks');
const gradescope = require('./gradescope');
const calendar = require('./calendar');
const updater = require('./updater');
const shape = require('./shape');

let mainWindow = null;
// Kennesaw ends a D2L session after 8 hours without activity, and each quiet
// refresh counts as activity, so checking well inside that keeps the session
// alive for as long as the computer is awake.
const REFRESH_EVERY = 2 * 60 * 60 * 1000;   // re-check D2L every two hours

function createWindow(hidden) {
  const win = new BrowserWindow({
    show: !hidden,
    width: 1180,
    height: 860,
    minWidth: 380,
    minHeight: 500,
    title: 'Owl Hours',
    backgroundColor: '#0B0E14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, 'app', 'index.html'));

  // D2L links and anything else external belong in the real browser,
  // where the user is already signed in.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  /* With "Keep running in the background" on, closing the window only hides
     it: the page is what sends reminders, so it has to stay alive. Quitting
     (menu, Cmd+Q, the tray, an update) still quits. */
  win.on('close', (e) => {
    if (quitting || !background.on) return;
    e.preventDefault();
    win.hide();
  });

  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  return win;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(false); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ---------- running in the background (optional, off by default) ----------
   Remembered in a small file so it is known before the page loads: at login
   the app starts with its window hidden. */
let quitting = false;
app.on('before-quit', () => { quitting = true; });

const BG_FILE = () => path.join(app.getPath('userData'), 'background.json');
const background = { on: false };
try { background.on = !!JSON.parse(fs.readFileSync(BG_FILE(), 'utf8')).on; } catch (e) { /* never set */ }

let tray = null;
function setTray(on) {
  /* The Mac keeps a Dock icon while the app runs, which reopens the window.
     Windows has nothing once the window is hidden, so it gets a tray icon. */
  if (isMac) return;
  if (on && !tray) {
    const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('Owl Hours');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Owl Hours', click: showWindow },
      { type: 'separator' },
      { label: 'Quit Owl Hours', click: () => app.quit() }
    ]));
    tray.on('click', showWindow);
  } else if (!on && tray) {
    tray.destroy();
    tray = null;
  }
}

function setBackground(on) {
  on = !!on;
  const changed = on !== background.on;
  background.on = on;
  if (changed) {
    try { fs.writeFileSync(BG_FILE(), JSON.stringify({ on })); } catch (e) { /* keeps working this session */ }
    try {
      app.setLoginItemSettings({ openAtLogin: on, args: on ? ['--hidden'] : [] });
    } catch (e) { /* not allowed on this system; staying open still works */ }
  }
  setTray(on);
  return { ok: true, on, atLogin: loginState() };
}
function loginState() {
  try { return !!app.getLoginItemSettings(isMac ? {} : { args: ['--hidden'] }).openAtLogin; } catch (e) { return false; }
}
const startedAtLogin = () => {
  if (process.argv.includes('--hidden')) return true;
  try { return isMac && !!app.getLoginItemSettings().wasOpenedAtLogin; } catch (e) { return false; }
};

const isMac = process.platform === 'darwin';

Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(isMac ? [{ role: 'appMenu' }] : []),
  { role: 'fileMenu' },
  { role: 'editMenu' },
  {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  },
  { role: 'windowMenu' }
]));

const send = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

/* One D2L read at a time. A quiet read that arrives while another is running
   shares its answer rather than opening a second window; a sign-in that
   arrives while a quiet read runs waits for it, and only opens the sign-in
   window if that read could not get in. */
let grabbing = null;      // { interactive, promise }
function grabOnce(interactive) {
  interactive = !!interactive;
  if (grabbing) {
    if (!interactive) return grabbing.promise;
    if (!grabbing.interactive) {
      return grabbing.promise.then((r) => (r && r.ok ? r : grabOnce(true)));
    }
    return grabbing.promise;
  }
  const promise = d2l.grab(interactive, (text) => send('owl:status', text)).then((res) => {
    if (!interactive) logQuiet(res);
    return res;
  }).finally(() => { if (grabbing && grabbing.promise === promise) grabbing = null; });
  grabbing = { interactive, promise };
  return promise;
}
function logQuiet(res) {
  if (!process.env.OWL_DEBUG) return;
  console.log('[owl] quiet refresh ->', JSON.stringify({
    ok: res.ok, needLogin: !!res.needLogin, stop: res.stop || null, error: res.error || null,
    courses: res.ok ? res.data.courses.length : 0
  }));
}

ipcMain.handle('owl:grab', (_e, interactive) => grabOnce(interactive));

ipcMain.handle('owl:signout', () => d2l.signOut());
/* Disconnecting one source from Sync (Gradescope) forgets just that site. */
ipcMain.handle('owl:forgetSite', (_e, origin) => d2l.forget(origin));
ipcMain.handle('owl:scan', (_e, orgUnits) => d2l.scan(orgUnits));

/* ALEKS is manual on purpose: it allows one session per account, so a
   background pull would sign the user out of ALEKS mid-homework. */
/* Safe to call any time: it looks at D2L only and never opens ALEKS. */
/* Gradescope has no session limit, so unlike ALEKS this can run unattended. */
ipcMain.handle('owl:gradescope', async (_e, interactive) => {
  const res = await gradescope.pull(!!interactive, (text) => send('owl:status', text));
  if (process.env.OWL_DEBUG) console.log('[owl] gradescope ->', JSON.stringify({ ok: res.ok, needLogin: !!res.needLogin, error: res.error || null, courses: res.ok ? res.courses.length : 0, items: res.ok ? res.courses.reduce((a, c) => a + c.items.length, 0) : 0 }));
  if (!res.ok) return res;
  return { ok: true, courses: shape.gradescope(res) };
});

/* The calendar carries the things that are never submitted anywhere — most
   importantly sit-down exams. Shaped like every other row so the agenda and
   calendar views need no special case, and flagged x:1 so a D2L refresh keeps
   it, the same way ALEKS and Gradescope rows survive. */
ipcMain.handle('owl:calendar', async (_e, orgUnits) => {
  const res = await calendar.pull(orgUnits || [], (text) => send('owl:status', text));
  if (process.env.OWL_DEBUG) console.log('[owl] calendar ->', JSON.stringify({ ok: res.ok, needLogin: !!res.needLogin, error: res.error || null, events: res.ok ? res.events.length : 0, read: res.ok ? res.read.length : 0, failed: res.ok ? res.failed.length : 0 }));
  if (!res.ok) return res;
  /* read: the courses D2L actually answered for; only those lose their old rows */
  return { ok: true, items: shape.calendar(res), read: res.read };
});

/* One-click updating. The check is cheap and runs on launch; nothing is
   downloaded until the user asks, and nothing is installed until they say so. */
ipcMain.handle('owl:updateCheck', () => updater.check());
ipcMain.handle('owl:updateDownload', () => updater.download());
ipcMain.handle('owl:updateInstall', () => updater.install());

ipcMain.handle('owl:alekscheck', (_e, courseIds) => aleks.findCourses(courseIds || []));

/* ALEKS allows one session per account, so a second pull while one is open
   would close the first. Never run two: a second request gets a clear no. */
let aleksBusy = false;
ipcMain.handle('owl:aleks', async (_e, courseIds) => {
  if (aleksBusy) return { ok: false, busy: true, error: 'ALEKS is already being read. Wait for it to finish.' };
  aleksBusy = true;
  try {
    const res = await aleks.pull(courseIds || [], (text) => send('owl:status', text));
    if (!res.ok) return res;
    return { ok: true, courses: shape.aleks(res), skipped: res.skipped };
  } finally {
    aleksBusy = false;
  }
});

ipcMain.handle('owl:setBackground', (_e, on) => setBackground(on));

/* On a timer and on wake. The page does the reading — D2L, Gradescope and
   the calendar together, minus whatever the user turned off in Sync, folded
   into one update — so it is only told when. With no page open (a Mac with
   its window closed) a quiet D2L read still runs, which keeps the session
   alive. Never ALEKS: it allows one session per account. A read already in
   progress is never doubled up. */
let pageRefreshes = false;
ipcMain.on('owl:refreshReady', () => { pageRefreshes = true; });

function refreshQuietly() {
  if (grabbing) return;
  if (mainWindow && !mainWindow.isDestroyed() && pageRefreshes) { send('owl:refresh'); return; }
  grabOnce(false).then((res) => {
    // A lapsed Kennesaw sign-in used to fail silently, so the app just looked
    // stale. Tell the window, and let the user decide when to sign in.
    if (!res.ok && res.needLogin) send('owl:needlogin', res.stop || null);
    if (res.ok) send('owl:data', res.data);
  });
}

/* A second launch (double-clicking the app again, or the login item firing
   while it is already open) brings up the window that is already running. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    const win = createWindow(background.on && startedAtLogin());
    setTray(background.on);
    updater.init(send);
    win.webContents.once('did-finish-load', () => {
      /* The launch refresh is started by the page itself, alongside
         Gradescope and the calendar, so the three land in one reload. */
      /* Ask GitHub once per launch whether there is anything newer. */
      setTimeout(() => { updater.check(); }, 4000);
      setInterval(refreshQuietly, REFRESH_EVERY);
      /* Timers stop while the computer sleeps, so a long sleep can outlast the
         session. Check again on wake; if D2L lapsed, Microsoft usually signs
         straight back in without asking. */
      let lastWake = 0;
      const onWake = () => {
        if (Date.now() - lastWake < 60 * 1000) return;
        lastWake = Date.now();
        setTimeout(refreshQuietly, 15 * 1000);
      };
      powerMonitor.on('resume', onWake);
      powerMonitor.on('unlock-screen', onWake);
    });
    /* The hidden reader windows count as windows, so ask about ours. A Mac
       also "activates" the app as it launches; when that launch was the
       login item starting it hidden, stay hidden. */
    const hiddenUntil = win.isVisible() ? 0 : Date.now() + 5000;
    app.on('activate', () => { if (Date.now() > hiddenUntil) showWindow(); });
  });
}

app.on('window-all-closed', () => {
  if (!isMac && !background.on) app.quit();
});
