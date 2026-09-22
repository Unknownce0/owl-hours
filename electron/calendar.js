/* The D2L calendar.
 *
 * Owl Hours read assignments, quizzes, discussions and grades — every object a
 * student submits something to. An exam written on paper in a classroom is not
 * one of those. It has no dropbox and no quiz, so the only place it exists in
 * D2L is the calendar, and the app was blind to it: an ECON exam five days out
 * appeared nowhere. This closes that.
 *
 * /d2l/api/le/1.67/{ou}/calendar/events/myEvents/ returns them as JSON, so no
 * HTML parsing. Two things about the shape matter:
 *
 *   - Deadlines have StartDateTime === EndDateTime (typically 03:59:59Z, which
 *     is 11:59:59pm Eastern the previous day). Real scheduled events have a
 *     genuine span — "Exam 1" runs 16:45Z to 17:40Z, a 55-minute sitting. That
 *     difference is how a timed exam is told apart from a due date.
 *   - Most entries duplicate something already scraped: a quiz usually appears
 *     twice here (opens, then closes) as well as in the quiz list. Only events
 *     with no match by name are kept, so the calendar adds what was missing
 *     rather than doubling everything.
 */
const { BrowserWindow } = require('electron');

const PARTITION = 'persist:d2l';
const HOME = 'https://kennesaw.view.usg.edu/d2l/home';

const isD2L = (url) => /^https:\/\/[^/]*\.view\.usg\.edu\//.test(url);

function readJS(orgUnits, fromISO, toISO) {
  return `(async function(){
    var OUS = ${JSON.stringify(orgUnits)};
    var out = [];
    for (var i = 0; i < OUS.length; i++) {
      var ou = OUS[i];
      try {
        var r = await fetch('/d2l/api/le/1.67/' + ou + '/calendar/events/myEvents/'
              + '?startDateTime=${fromISO}&endDateTime=${toISO}',
              { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!r.ok) continue;
        var j = await r.json();
        var arr = j.Objects || j.Items || j || [];
        if (!Array.isArray(arr)) continue;
        for (var k = 0; k < arr.length; k++) {
          var x = arr[k];
          out.push({
            ou: ou,
            id: x.CalendarEventId,
            n: (x.Title || '').replace(/\\s+/g, ' ').trim(),
            start: x.StartDateTime,
            end: x.EndDateTime,
            allDay: !!x.IsAllDayEvent,
            where: x.LocationName || '',
            entity: x.AssociatedEntity ? (x.AssociatedEntity.AssociatedEntityType || 'linked') : null
          });
        }
      } catch (e) { /* one bad course must not lose the rest */ }
    }
    return JSON.stringify(out);
  })()`;
}

function load(win, url) {
  return new Promise((r) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; r(); } };
    win.webContents.once('did-finish-load', done);
    win.webContents.once('did-fail-load', done);
    setTimeout(done, 30000);
    win.loadURL(url);
  });
}

/**
 * @param {number[]} orgUnits course ids to read
 * @param {(s:string)=>void} say
 */
async function pull(orgUnits, say = () => {}) {
  if (!orgUnits || !orgUnits.length) return { ok: false, error: 'no courses to read' };

  const win = new BrowserWindow({
    show: false, width: 1024, height: 780,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const close = () => { if (!win.isDestroyed()) win.destroy(); };

  try {
    say('Reading your course calendars…');
    await load(win, HOME);
    if (!isD2L(win.webContents.getURL())) { close(); return { ok: false, needLogin: true }; }

    // A wide window: exams get scheduled the whole term out, not just this month.
    const from = new Date(Date.now() - 14 * 864e5).toISOString();
    const to = new Date(Date.now() + 365 * 864e5).toISOString();

    const raw = await win.webContents.executeJavaScript(readJS(orgUnits, from, to), true);
    close();

    let events = [];
    try { events = JSON.parse(raw); } catch (e) { return { ok: false, error: 'could not read the calendar' }; }
    return { ok: true, events };
  } catch (e) {
    close();
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** A timed sitting rather than a deadline: a real span, not a single instant. */
function isScheduled(ev) {
  if (!ev.start || !ev.end) return false;
  const a = Date.parse(ev.start), b = Date.parse(ev.end);
  return isFinite(a) && isFinite(b) && (b - a) >= 60000;
}

module.exports = { pull, isScheduled };
