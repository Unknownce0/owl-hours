/* Which courses KSU expects to actually run, and when.
 *
 * Advising publishes a forecast page of ~150 tables, one per subject prefix,
 * each shaped:
 *
 *     Course     FA26   SP27   SU27   FA27   SP28   SU28
 *     CS 3305    F/O    F/O    F/O    F/O    F/O    F/O
 *     CS 3410    F/O    F/O    O      F/O    F/O    O
 *
 * Values are modality (F face-to-face, H hybrid, O online, O(S) synchronous,
 * O(A) asynchronous, * scheduled but modality undecided) and "-" for not
 * scheduled. The page's own legend says these are tentative, so this is used
 * to warn that something is not expected to run — never to promise it will.
 *
 * Being eligible for a course is useless if it is not offered, which is why
 * this sits alongside the catalog prerequisites rather than replacing them.
 */
const { BrowserWindow } = require('electron');

const URL = 'https://campus.kennesaw.edu/current-students/academics/academic-advising/resources/course-forecasts-1.php';

const READ = `(function(){
  function clean(s){ return (s||'').replace(/\\s+/g,' ').trim(); }
  var terms = null, out = {};

  [].forEach.call(document.querySelectorAll('table'), function(t){
    var rows = t.querySelectorAll('tr');
    if(rows.length < 2) return;

    var head = [].map.call(rows[0].querySelectorAll('th,td'), function(c){ return clean(c.textContent); });
    // A forecast table starts with "Course" and then term columns like FA26.
    if(!/^course$/i.test(head[0] || '')) return;
    var cols = head.slice(1).filter(function(h){ return /^(FA|SP|SU)\\d{2}$/i.test(h); });
    if(!cols.length) return;
    if(!terms) terms = cols;

    for(var i = 1; i < rows.length; i++){
      var cells = [].map.call(rows[i].querySelectorAll('th,td'), function(c){ return clean(c.textContent); });
      if(cells.length < 2) continue;
      var m = (cells[0] || '').match(/^([A-Z]{2,5})\\s*(\\d{3,4}[A-Z]?)$/);
      if(!m) continue;
      var code = m[1] + ' ' + m[2], row = {};
      for(var c = 0; c < cols.length; c++){
        var v = cells[c + 1] || '';
        row[cols[c]] = (v === '-' || v === '') ? null : v;   // null = not scheduled
      }
      out[code] = row;
    }
  });

  return JSON.stringify({ terms: terms || [], courses: out });
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

/** @param {(s:string)=>void} say */
async function pull(say = () => {}) {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const close = () => { if (!win.isDestroyed()) win.destroy(); };
  try {
    say('Checking which courses are offered…');
    await load(win, URL);
    await waitFor(win.webContents, "document.querySelectorAll('table').length > 20", 20000);
    const raw = await win.webContents.executeJavaScript(READ, true);
    close();
    let data;
    try { data = JSON.parse(raw); } catch (e) { return { ok: false, error: 'could not read the forecast' }; }
    if (!data.courses || !Object.keys(data.courses).length) return { ok: false, error: 'the forecast came back empty' };
    data.scrapedAt = new Date().toISOString();
    return { ok: true, forecast: data };
  } catch (e) {
    close();
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { pull };
