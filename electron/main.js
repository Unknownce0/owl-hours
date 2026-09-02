const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const d2l = require('./d2l');
const aleks = require('./aleks');

let mainWindow = null;
const REFRESH_EVERY = 6 * 60 * 60 * 1000;   // re-check D2L every six hours

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 380,
    minHeight: 500,
    title: 'Owl Hours',
    backgroundColor: '#14130F',
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

  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  return win;
}

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

ipcMain.handle('owl:grab', async (_e, interactive) => {
  return d2l.grab(interactive, (text) => send('owl:status', text));
});

ipcMain.handle('owl:signout', () => d2l.signOut());

/* ALEKS is manual on purpose: it allows one session per account, so a
   background pull would sign the user out of ALEKS mid-homework. */
/* Safe to call any time: it looks at D2L only and never opens ALEKS. */
ipcMain.handle('owl:alekscheck', (_e, courseIds) => aleks.findCourses(courseIds || []));

ipcMain.handle('owl:aleks', async (_e, courseIds) => {
  const res = await aleks.pull(courseIds || [], (text) => send('owl:status', text));
  if (!res.ok) return res;
  // shape ALEKS rows like everything else, flagged x:1 so a D2L refresh keeps them
  const courses = res.courses.map((c) => ({
    ou: c.ou,
    items: c.items.map((i) => {
      const done = /closed/i.test(i.status) || i.pct === 100;
      return {
        t: /quiz|test|exam/i.test(i.type) ? 'q' : 'a',
        n: i.n + '  (ALEKS)',
        d: i.d || undefined,
        o: i.o || undefined,
        s: done ? 'Completed' : 'Not Submitted',
        e: i.pct != null ? i.pct : undefined,
        p: i.pct != null ? 100 : undefined,
        x: 1
      };
    })
  }));
  return { ok: true, courses, skipped: res.skipped };
});

/* A quiet attempt on launch, then on a timer. If the session has lapsed we say
   nothing and wait for the user to ask — no surprise login windows. */
async function refreshQuietly() {
  const res = await d2l.grab(false);
  // A lapsed Kennesaw sign-in used to fail silently, so the app just looked
  // stale. Tell the window, and let the user decide when to sign in.
  if (!res.ok && res.needLogin) send('owl:needlogin', true);
  if (process.env.OWL_DEBUG) {
    console.log('[owl] quiet refresh ->', JSON.stringify({
      ok: res.ok, needLogin: !!res.needLogin, error: res.error || null,
      courses: res.ok ? res.data.courses.length : 0
    }));
  }
  if (res.ok) send('owl:data', res.data);
}

app.whenReady().then(() => {
  const win = createWindow();
  win.webContents.once('did-finish-load', () => {
    setTimeout(refreshQuietly, 1500);
    setInterval(refreshQuietly, REFRESH_EVERY);
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
