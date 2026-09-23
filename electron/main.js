const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const d2l = require('./d2l');
const aleks = require('./aleks');
const gradescope = require('./gradescope');
const calendar = require('./calendar');
const updater = require('./updater');

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
/* Gradescope has no session limit, so unlike ALEKS this can run unattended. */
ipcMain.handle('owl:gradescope', async (_e, interactive) => {
  const res = await gradescope.pull(!!interactive, (text) => send('owl:status', text));
  if (!res.ok) return res;
  /* Once graded, Gradescope replaces the status with the score itself
     ("105.0 / 100.0"). Saved verbatim, no rule recognised it as done. */
  const score = (st) => String(st || '').match(/^\s*(-?[\d.]+)\s*\/\s*([\d.]+)\s*$/);
  const courses = res.courses.map((c) => ({
    code: c.code,
    name: c.name,
    items: c.items.map((i) => { const sc = score(i.status); return {
      t: 'a',
      n: i.n + '  (Gradescope)',
      d: i.d || undefined,
      o: i.o || undefined,
      s: sc ? 'Graded' : /no submission/i.test(i.status) ? 'Not Submitted' : (i.status || 'Submitted'),
      e: sc ? +sc[1] : undefined,
      p: sc ? +sc[2] : undefined,
      u: i.u ? 'https://www.gradescope.com' + i.u : 'https://www.gradescope.com' + c.href,
      x: 1,
      src: 'gs'
    }; })
  }));
  return { ok: true, courses };
});

/* The calendar carries the things that are never submitted anywhere — most
   importantly sit-down exams. Shaped like every other row so the agenda and
   calendar views need no special case, and flagged x:1 so a D2L refresh keeps
   it, the same way ALEKS and Gradescope rows survive. */
ipcMain.handle('owl:calendar', async (_e, orgUnits) => {
  const res = await calendar.pull(orgUnits || [], (text) => send('owl:status', text));
  if (!res.ok) return res;
  /* Courses bulk-stamp their content modules onto the calendar: DANC 1107 has
     fourteen "Week N - <topic>" entries all sharing one timestamp near the end
     of term. Those are availability markers, not deadlines, and adding them
     would drop fourteen rows onto a single December day. A timestamp shared by
     five or more events in one course is that pattern, never five real
     deadlines that happen to coincide. */
  const stamp = {};
  res.events.forEach((ev) => {
    const k = ev.ou + '|' + ev.start + '|' + ev.end;
    stamp[k] = (stamp[k] || 0) + 1;
  });

  /* Exact-match alone was not enough. COMM 1100 carries fifteen textbook
     chapter entries stamped 2:53 to 2:56 one afternoon — bulk-added a minute
     apart as the instructor clicked through, so no two share an instant and
     all fifteen sailed past the filter into the agenda as overdue work.
     The tell is the spread itself: real deadlines in a course land on the
     same instant (11:59pm), while bulk-stamped content dribbles across a few
     minutes. So: five or more in one course inside a quarter hour, not all at
     the same moment. */
  const byCourse = {};
  res.events.forEach((ev) => {
    const t = Date.parse(ev.start);
    if (!isFinite(t)) return;
    (byCourse[ev.ou] = byCourse[ev.ou] || []).push(t);
  });
  const WINDOW = 15 * 60 * 1000;
  const smeared = (ev) => {
    const t = Date.parse(ev.start);
    if (!isFinite(t)) return false;
    const near = (byCourse[ev.ou] || []).filter((x) => Math.abs(x - t) <= WINDOW);
    if (near.length < 5) return false;
    return near.some((x) => x !== t);      // spread, not one shared deadline
  };

  const bulk = (ev) => stamp[ev.ou + '|' + ev.start + '|' + ev.end] >= 5 || smeared(ev);

  /* An event attached to a quiz, dropbox or discussion is only that item's due
     date — the item itself is already on the page with its real done status.
     Adding the calendar copy too gave a second row with no status, which read
     as overdue forever: COMM's "Unit 1"/"Unit 2" were exactly that. Events
     attached to content pages are reading markers. What is left, attached to
     nothing, is a sit-down exam: the one thing only the calendar knows. */
  const items = res.events.filter((ev) => !ev.entity && !bulk(ev)).map((ev) => {
    const timed = calendar.isScheduled(ev);
    const isExam = /\b(exam|midterm|final|test)\b/i.test(ev.n);
    return {
      ou: ev.ou,
      t: isExam ? 'q' : 'a',
      /* For something you sit at a fixed hour, the moment that matters is when
         it starts, not when it ends. For a deadline the end is the deadline. */
      d: timed ? ev.start : (ev.end || ev.start),
      n: ev.n + (timed ? '  (scheduled)' : ''),
      /* A calendar entry carries no submission state — there is nothing to
         submit to. Claiming "Not Submitted" invented a fact and painted work
         already finished as outstanding. Leave it blank; the tick box is
         there for anyone who wants to mark it off. */
      where: ev.where || undefined,
      /* kept so the page can show the whole window and know when it is over */
      end: timed ? ev.end : undefined,
      timed: timed ? 1 : undefined,
      exam: isExam ? 1 : undefined,
      x: 1,
      src: 'cal'
    };
  });
  return { ok: true, items };
});

/* One-click updating. The check is cheap and runs on launch; nothing is
   downloaded until the user asks, and nothing is installed until they say so. */
ipcMain.handle('owl:updateCheck', () => updater.check());
ipcMain.handle('owl:updateDownload', () => updater.download());
ipcMain.handle('owl:updateInstall', () => updater.install());

ipcMain.handle('owl:alekscheck', (_e, courseIds) => aleks.findCourses(courseIds || []));

ipcMain.handle('owl:aleks', async (_e, courseIds) => {
  const res = await aleks.pull(courseIds || [], (text) => send('owl:status', text));
  if (!res.ok) return res;
  // shape ALEKS rows like everything else, flagged x:1 so a D2L refresh keeps them
  const courses = res.courses.map((c) => ({
    ou: c.ou,
    items: c.items.map((i) => {
      /* "Closed" is the deadline having passed, NOT the work being finished —
         an assignment never started reads Closed the moment it is late, so
         this was marking missed work as complete. ALEKS states its real
         answer in the progress column and the "N out of N topics completed"
         detail behind it. */
      const tp = String(i.details || '').match(/(\d+)\s+out of\s+(\d+)\s+topics completed/i);
      /* A test or knowledge check is one sitting: any recorded result means it
         was taken. Requiring 100% marked a sat test as "Not Submitted". */
      const oneSitting = /quiz|test|exam|knowledge check/i.test((i.type || '') + ' ' + (i.n || ''));
      const done = oneSitting
        ? (i.pct != null && i.pct > 0) || /submitted|completed/i.test(i.status || '')
        : i.pct === 100 || !!(tp && +tp[2] > 0 && tp[1] === tp[2]);
      /* ALEKS submits whatever is done when the deadline hits, so past the due
         date any progress is a submitted score (70% is a grade, not a miss).
         Only 0% past the deadline is actually missed. */
      const pastDue = !!(i.d && Date.parse(i.d) < Date.now());
      const autoSubmitted = !done && pastDue && i.pct != null && i.pct > 0;
      return {
        t: /quiz|test|exam/i.test(i.type) ? 'q' : 'a',
        n: i.n + '  (ALEKS)',
        d: i.d || undefined,
        o: i.o || undefined,
        s: done ? 'Completed' : autoSubmitted ? 'Submitted' : 'Not Submitted',
        e: i.pct != null ? i.pct : undefined,
        p: i.pct != null ? 100 : undefined,
        x: 1,
        src: 'aleks'
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
  updater.init(send);
  win.webContents.once('did-finish-load', () => {
    setTimeout(refreshQuietly, 1500);
    /* Ask GitHub once per launch whether there is anything newer. */
    setTimeout(() => { updater.check(); }, 4000);
    setInterval(refreshQuietly, REFRESH_EVERY);
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
