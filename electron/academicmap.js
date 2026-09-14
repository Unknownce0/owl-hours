/* Reading KSU's published academic maps — the suggested four-year schedule
 * for a degree program.
 *
 * These are public: no sign-in, no session, nothing personal. That matters
 * because Owl Hours is shared with friends in other majors, and every KSU
 * program has a stable id here (T0001108 is BS Computer Science), so one code
 * path serves all ~120 of them.
 *
 * The page is a small single-page app, so the tables only exist after its
 * scripts run — hence a real window rather than a plain fetch. Each program
 * page renders exactly eight tables in document order, one per term, which is
 * what the term numbering below relies on.
 */
const { BrowserWindow } = require('electron');

const LIST_URL = 'https://public-apps.kennesaw.edu/academic-maps';
const PROGRAM_URL = 'https://public-apps.kennesaw.edu/academic-maps/programs/';

/* Every program, as {id, name}. The trailing "26" on each label is the catalog
   year, which is noise once you are inside a program, so it comes off here. */
const LIST_PROGRAMS = `(function(){
  var seen = {}, out = [];
  [].forEach.call(document.querySelectorAll('a[href*="/academic-maps/programs/"]'), function(a){
    var m = (a.getAttribute('href')||'').match(/programs\\/([A-Za-z0-9]+)/);
    if(!m || seen[m[1]]) return;
    seen[m[1]] = 1;
    var name = (a.textContent||'').replace(/\\s+/g,' ').trim().replace(/\\s+\\d{2}$/,'');
    if(name) out.push({ id: m[1], name: name });
  });
  return JSON.stringify(out);
})()`;

const MAP_READY = "document.querySelectorAll('table').length >= 8";

/* One program's map: eight terms of rows.

   A row is either a real course ("CSE 1321L  Program Problem Solving I Lab")
   or a placeholder the student fills in later ("Free Elective (1 of 2)",
   "General Education Core IMPACTS- Mathematics"). Both are kept — a map with
   the electives silently dropped would understate what is left to do — but
   only the real ones get a course code, which is what we match against the
   audit. The per-term "Total" row is not a requirement and is skipped. */
const READ_MAP = `(function(){
  function clean(s){ return (s||'').replace(/\\s+/g,' ').trim(); }

  var title = '';
  var h = document.querySelector('h1, h2');
  if(h) title = clean(h.textContent).replace(/\\s+\\d{2}$/,'');

  var totalHours = null;
  var mt = clean(document.body.innerText).match(/Total Hours:\\s*(\\d+)/i);
  if(mt) totalHours = parseInt(mt[1], 10);

  var terms = [];
  [].forEach.call(document.querySelectorAll('table'), function(tbl, ti){
    var rows = [];
    [].forEach.call(tbl.querySelectorAll('tr'), function(tr){
      var cells = tr.querySelectorAll('td');
      if(cells.length < 2) return;                       // header row
      var text  = clean(cells[0].textContent);
      var hours = parseFloat(clean(cells[1].textContent));
      if(!text || /^total$/i.test(text)) return;         // per-term subtotal

      var cm = text.match(/^([A-Z]{2,5})\\s*(\\d{3,4}[A-Z]?)\\b\\s*(.*)$/);
      rows.push({
        code:  cm ? (cm[1] + ' ' + cm[2]) : null,
        name:  cm ? clean(cm[3]) : text,
        hours: isFinite(hours) ? hours : 0
      });
    });
    if(rows.length) terms.push({ term: ti + 1, year: Math.floor(ti / 2) + 1, rows: rows });
  });

  return JSON.stringify({ title: title, totalHours: totalHours, terms: terms });
})()`;

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

function waitFor(wc, expr, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    (function tick() {
      if (Date.now() > deadline) return resolve(false);
      wc.executeJavaScript(expr, true)
        .then((ok) => (ok ? resolve(true) : setTimeout(tick, everyMs)))
        .catch(() => setTimeout(tick, everyMs));
    })();
  });
}

function hidden() {
  return new BrowserWindow({
    show: false, width: 1200, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
}

/** Every program KSU publishes a map for. */
async function listPrograms() {
  const win = hidden();
  const close = () => { if (!win.isDestroyed()) win.destroy(); };
  try {
    await load(win, LIST_URL);
    await waitFor(win.webContents, "document.querySelectorAll('a[href*=\"/academic-maps/programs/\"]').length > 5", 20000);
    const raw = await win.webContents.executeJavaScript(LIST_PROGRAMS, true);
    close();
    let programs = [];
    try { programs = JSON.parse(raw); } catch (e) { /* leave empty */ }
    if (!programs.length) return { ok: false, error: 'no programs found' };
    return { ok: true, programs };
  } catch (e) {
    close();
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * @param {string} id  program id, e.g. "T0001108"
 * @param {(s:string)=>void} say progress reporter
 */
async function readProgram(id, say = () => {}) {
  if (!/^[A-Za-z0-9]+$/.test(String(id || ''))) return { ok: false, error: 'bad program id' };
  const win = hidden();
  const close = () => { if (!win.isDestroyed()) win.destroy(); };
  try {
    say('Loading your program map…');
    await load(win, PROGRAM_URL + id);
    const ready = await waitFor(win.webContents, MAP_READY, 25000);
    if (!ready) { close(); return { ok: false, error: 'the map did not finish loading' }; }
    const raw = await win.webContents.executeJavaScript(READ_MAP, true);
    close();
    let map;
    try { map = JSON.parse(raw); } catch (e) { return { ok: false, error: 'could not read the map' }; }
    if (!map.terms || !map.terms.length) return { ok: false, error: 'the map came back empty' };
    map.id = id;
    map.scrapedAt = new Date().toISOString();
    return { ok: true, map };
  } catch (e) {
    close();
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { listPrograms, readProgram };
