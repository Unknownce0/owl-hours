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
const remote = require('./remote');

/* Every course is read at once. Each reply says whether that course was read,
   so a failure can't pass for "no events": the app clears a course's old
   calendar rows only when that course was actually read again. */
function readJS(orgUnits, fromISO, toISO) {
  return `(async function(){
    var OUS = ${JSON.stringify(orgUnits)};
    var per = await Promise.all(OUS.map(async function(ou){
      try {
        var r = await fetch('/d2l/api/le/1.67/' + ou + '/calendar/events/myEvents/'
              + '?startDateTime=${fromISO}&endDateTime=${toISO}',
              { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!r.ok) return null;
        var j = await r.json();
        var arr = j.Objects || j.Items || j || [];
        if (!Array.isArray(arr)) return null;
        return arr.map(function(x){ return {
          ou: ou,
          id: x.CalendarEventId,
          n: (x.Title || '').replace(/\\s+/g, ' ').trim(),
          start: x.StartDateTime,
          end: x.EndDateTime,
          allDay: !!x.IsAllDayEvent,
          where: x.LocationName || '',
          entity: x.AssociatedEntity ? (x.AssociatedEntity.AssociatedEntityType || 'linked') : null
        }; });
      } catch (e) { return null; }   /* one bad course must not lose the rest */
    }));
    var events = [], read = [], failed = [];
    per.forEach(function(list, i){
      if (list) { read.push(OUS[i]); events = events.concat(list); } else failed.push(OUS[i]);
    });
    return JSON.stringify({ events: events, read: read, failed: failed });
  })()`;
}

/** Turn what the page returned into a result. Pure, so it can be tested. */
function interpret(raw) {
  let j;
  try { j = JSON.parse(raw); } catch (e) { return { ok: false, error: 'could not read the calendar' }; }
  if (!j || !Array.isArray(j.events)) return { ok: false, error: 'could not read the calendar' };
  /* Every course failing is not "no exams": returning ok with nothing let the
     app wipe every exam it knew about. */
  if (!j.read || !j.read.length) return { ok: false, error: 'D2L did not answer for any course calendar' };
  return { ok: true, events: j.events, read: j.read, failed: j.failed || [] };
}

/**
 * @param {number[]} orgUnits course ids to read
 * @param {(s:string)=>void} say
 */
async function pull(orgUnits, say = () => {}) {
  if (!orgUnits || !orgUnits.length) return { ok: false, error: 'no courses to read' };

  const win = remote.open();
  const close = () => { if (!win.isDestroyed()) win.destroy(); };

  try {
    say('Reading your course calendars…');
    if (!(await remote.d2lSignedIn(win))) { close(); return { ok: false, needLogin: true }; }

    // A wide window: exams get scheduled the whole term out, not just this month.
    const from = new Date(Date.now() - 14 * 864e5).toISOString();
    const to = new Date(Date.now() + 365 * 864e5).toISOString();

    const raw = await win.webContents.executeJavaScript(readJS(orgUnits, from, to), true);
    close();
    return interpret(raw);
  } catch (e) {
    close();
    return { ok: false, error: String((e && e.message) || e) };
  }
}

const { isScheduled } = require('./shape');

module.exports = { pull, isScheduled, interpret };
