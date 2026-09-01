/* Pulling coursework out of ALEKS.
 *
 * D2L knows nothing about ALEKS, so classes that run their work there (Precalc,
 * Chemistry, and friends) show up empty. There is no ALEKS API worth the name -
 * it is a CGI app that POSTs to opaque session URLs - so this drives the real UI
 * in a real window, the same way a person would.
 *
 * Two things shape the design:
 *   - ALEKS permits ONE session per account. Launching it signs the user out of
 *     ALEKS everywhere else, so this must never run on a timer. Manual only.
 *   - The launch link lives in D2L as an LTI quicklink, and its id differs per
 *     course, so it is discovered from D2L's content API rather than hardcoded.
 */
const { BrowserWindow } = require('electron');

const PARTITION = 'persist:d2l';
const D2L = 'https://kennesaw.view.usg.edu';

/** Find every ALEKS launch link across the user's courses. */
async function findLaunchLinks(win, courseIds) {
  const code = `(function(){
    var ids = ${JSON.stringify(courseIds)};
    return Promise.all(ids.map(function(ou){
      return fetch('/d2l/api/le/1.67/'+ou+'/content/toc',{credentials:'same-origin'})
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(j){
          if(!j) return null;
          var out = [];
          (function walk(mods){
            (mods||[]).forEach(function(m){
              (m.Topics||[]).forEach(function(t){
                var hay = ((t.Title||'') + ' ' + (m.Title||'')).toLowerCase();
                // an LTI link whose title mentions ALEKS is the launch point
                if (t.TypeIdentifier === 'Link' && hay.indexOf('aleks') >= 0 && t.Url) {
                  out.push({ou: ou, title: t.Title, url: t.Url});
                }
              });
              walk(m.Modules);
            });
          })(j.Modules);
          return out.length ? out[0] : null;
        }).catch(function(){ return null; });
    })).then(function(r){ return JSON.stringify(r.filter(Boolean)); });
  })()`;
  const raw = await win.webContents.executeJavaScript(code, true);
  try { return JSON.parse(raw); } catch (e) { return []; }
}

/** Poll a predicate in the page until it is true, or give up. */
function waitFor(wc, expr, timeoutMs, everyMs = 700) {
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

const ON_ALEKS = "/aleks\\.com$/.test(location.hostname)";
const ON_CLASSES = "/My Classes/i.test(document.title)";
/* The title is set before the tiles render, so waiting on it alone lands on a
   page that still says "Loading". Wait for a tile that looks like a class. */
const CLASS_TILES_READY = "(function(){return [].slice.call(document.querySelectorAll('*')).some(function(e){" +
  "if(e.children.length>3)return false;" +
  "var s=(e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim();" +
  "return s.length>5&&s.length<90&&/[A-Z]{2,5}\\s?\\d{3,4}|\\b(fall|spring|summer)\\s+\\d{4}\\b/i.test(s)&&!/loading/i.test(s);})})()";
// the class shell is up once its hamburger exists
/* The menu exists on the class list too, so that alone proves nothing.
   The class is open once the title is no longer "My Classes". */
const ON_CLASS_HOME = "!/My Classes/i.test(document.title) && /aleks/i.test(document.title)";
const MENU_OPEN = "!!document.getElementById('smt_hamburgermenu_button_input_assignmentList')";
const ON_ASSIGNMENTS = "/Assignments/i.test(document.title) && document.querySelectorAll('.column-displayDueDate').length > 0";

/* Read the assignments grid. Every cell carries a semantic class
   (column-name, column-displayDueDate, ...), so this reads by meaning
   rather than by column position, which would break on any reorder. */
const PARSE = `(function(){
  function cell(row, name){
    var el = row.querySelector('.column-' + name);
    return el ? (el.innerText||'').replace(/\\s+/g,' ').trim() : '';
  }
  function parseDate(s){
    var m = (s||'').match(/(\\d{2})\\/(\\d{2})\\/(\\d{4})(?:\\s+(\\d{1,2}):(\\d{2})\\s*(AM|PM))?/i);
    if(!m) return null;
    var h = m[4] ? +m[4] : 23, mi = m[5] ? +m[5] : 59;
    if(/pm/i.test(m[6]||'') && h < 12) h += 12;
    if(/am/i.test(m[6]||'') && h === 12) h = 0;
    return new Date(+m[3], +m[1]-1, +m[2], h, mi).toISOString();
  }
  var out = [], seen = {};
  document.querySelectorAll('tr, [role="row"]').forEach(function(row){
    if(!row.querySelector('.column-name')) return;
    var name = cell(row,'name');
    if(!name || seen[name]) return;
    seen[name] = 1;
    var status = cell(row,'displayStatus');
    var progress = cell(row,'progress');
    var details = cell(row,'details');
    var pm = progress.match(/(\\d+)\\s*%/);
    out.push({
      n: name,
      d: parseDate(cell(row,'displayDueDate')),
      o: parseDate(cell(row,'displayStartDate')),
      type: cell(row,'displayType'),
      status: status,
      pct: pm ? +pm[1] : null,
      details: details.slice(0, 60)
    });
  });
  return JSON.stringify({className: (document.title||''), items: out});
})()`;

/**
 * @param {string[]} courseIds  D2L org unit ids to look for ALEKS links in
 * @param {(s:string)=>void} say  progress reporter
 */
async function pull(courseIds, say = () => {}) {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820, title: 'ALEKS',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const wc = win.webContents;
  const close = () => { if (!win.isDestroyed()) win.destroy(); };

  try {
    say('Looking for ALEKS in your courses…');
    await new Promise((r) => { wc.once('did-finish-load', r); wc.once('did-fail-load', r); win.loadURL(D2L + '/d2l/home'); });
    if (!/view\.usg\.edu/.test(wc.getURL())) { close(); return { ok: false, needLogin: true }; }

    const links = await findLaunchLinks(win, courseIds);
    if (!links.length) { close(); return { ok: false, error: 'no ALEKS link found in any of your D2L courses' }; }

    const results = [];
    for (const link of links) {
      say('Opening ALEKS… this signs you out of ALEKS elsewhere.');
      await new Promise((r) => { wc.once('did-finish-load', r); wc.once('did-fail-load', r); win.loadURL(D2L + link.url); });

      if (!(await waitFor(wc, ON_ALEKS, 30000))) { results.push({ ou: link.ou, error: 'ALEKS did not open' }); continue; }

      // the launch lands either on the class list or straight in the class
      if (await waitFor(wc, ON_CLASSES, 6000)) {
        if (!(await waitFor(wc, CLASS_TILES_READY, 30000))) {
          results.push({ ou: link.ou, error: 'the ALEKS class list never rendered' });
          continue;
        }
        say('Entering your class…');
        /* The class tile's clickable element isn't consistently labelled, so try
           the accessible name, then the visible text, then the tile itself. */
        /* The tile is a custom element and a DOM .click() on its label does not
           navigate. Locate it, then send a real mouse click at its centre —
           the same thing a person does. */
        const box = await wc.executeJavaScript(`(function(){
          function clean(s){ return String(s||'').replace(/\\s+/g,' ').trim(); }
          var CLASSNAME = /[A-Z]{2,5}\\s?\\d{3,4}|\\b(fall|spring|summer)\\s+\\d{4}\\b/i;
          var best = null;
          [].slice.call(document.querySelectorAll('*')).forEach(function(e){
            if(best || e.children.length > 3) return;
            var s = clean(e.innerText || e.textContent);
            if(s.length < 6 || s.length > 90) return;
            if(!CLASSNAME.test(s)) return;
            if(/instructor|institution|access expires|progress|add\\/change|loading/i.test(s)) return;
            var r = e.getBoundingClientRect();
            if(r.width < 20 || r.height < 8) return;
            best = { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), s: s.slice(0,44) };
          });
          return JSON.stringify(best);
        })()`, true).catch(() => 'null');

        let target = null;
        try { target = JSON.parse(box); } catch (e) { /* leave null */ }
        if (!target) { results.push({ ou: link.ou, error: 'could not locate the class tile' }); continue; }

        say('Entering ' + target.s + '…');
        wc.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 });
      }

      /* Entering the class is a full navigation, which tears down anything
         injected beforehand — so wait for the new page before touching it. */
      if (!(await waitFor(wc, ON_CLASS_HOME, 40000))) {
        // report what we were actually looking at, rather than a bare failure
        const seen = await wc.executeJavaScript(
          "JSON.stringify({title:document.title,host:location.hostname,buttons:[].slice.call(document.querySelectorAll('button')).map(function(b){return (b.getAttribute('aria-label')||b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,26)}).filter(Boolean).slice(0,10)})",
          true).catch(() => '{}');
        results.push({ ou: link.ou, error: 'the ALEKS class never finished loading', seen: seen });
        continue;
      }

      say('Reading your assignments…');
      await wc.executeJavaScript(`(function(){
        var b = [].slice.call(document.querySelectorAll('button')).filter(function(x){
          var n = (x.getAttribute('aria-label') || x.innerText || '');
          return /main menu/i.test(n);
        })[0];
        if(b){ b.click(); return true; }
        return false;
      })()`, true).catch(() => {});

      if (!(await waitFor(wc, MENU_OPEN, 15000))) {
        results.push({ ou: link.ou, error: 'the ALEKS menu did not open' });
        continue;
      }
      await wc.executeJavaScript(
        "(function(){var a=document.getElementById('smt_hamburgermenu_button_input_assignmentList');if(a){a.click();return true}return false})()",
        true).catch(() => {});

      if (!(await waitFor(wc, ON_ASSIGNMENTS, 40000))) {
        results.push({ ou: link.ou, error: 'could not reach the assignments list' });
        continue;
      }

      const raw = await wc.executeJavaScript(PARSE, true);
      let parsed; try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed || !parsed.items.length) { results.push({ ou: link.ou, error: 'no assignments found' }); continue; }
      results.push({ ou: link.ou, className: parsed.className, items: parsed.items });
    }

    close();
    const good = results.filter((r) => r.items && r.items.length);
    if (!good.length) {
      const f = results[0] || {};
      return { ok: false, error: f.error || 'nothing read from ALEKS', seen: f.seen };
    }
    return { ok: true, courses: good, skipped: results.filter((r) => r.error) };
  } catch (e) {
    close();
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { pull };
