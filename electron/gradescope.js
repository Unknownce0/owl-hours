/* Pulling coursework out of Gradescope.
 *
 * Some classes hand out their real work here and leave D2L nearly empty — CSE
 * 1321L had four placeholder items in D2L and every actual lab in Gradescope.
 *
 * Unlike ALEKS, Gradescope has no one-session-per-account rule, so this is safe
 * to run on the ordinary refresh rather than only when asked.
 *
 * Its markup is unusually good to scrape: assignment rows carry semantic classes
 * and, best of all, real <time datetime="..."> values, so no date parsing guesswork.
 */
const { BrowserWindow } = require('electron');

const PARTITION = 'persist:d2l';          // one signed-in profile for everything
const HOME = 'https://www.gradescope.com/account';

const LOGGED_IN = "!/\\/login/.test(location.pathname) && !!document.querySelector('a[href^=\"/courses/\"]')";
const NEEDS_LOGIN = "/\\/login/.test(location.pathname) || !!document.querySelector('form[action*=\"login\"]')";

/** Every course this account is enrolled in. */
const LIST_COURSES = `(function(){
  var seen = {}, out = [];
  [].forEach.call(document.querySelectorAll('a[href^="/courses/"]'), function(a){
    var href = a.getAttribute('href');
    if(!/^\\/courses\\/\\d+$/.test(href) || seen[href]) return;
    seen[href] = 1;
    var short = a.querySelector('.courseBox--shortname');
    var name  = a.querySelector('.courseBox--name');
    out.push({
      href: href,
      code: short ? (short.innerText||'').replace(/\\s+/g,' ').trim() : '',
      name: name ? (name.innerText||'').replace(/\\s+/g,' ').trim() : ''
    });
  });
  return JSON.stringify(out);
})()`;

/** The assignment table for one course. */
const READ_COURSE = `(function(){
  function clean(s){ return (s||'').replace(/\\s+/g,' ').trim(); }
  function iso(el){
    if(!el) return null;
    var raw = el.getAttribute('datetime');           // "2026-09-20 23:59:00 -0400"
    if(!raw) return null;
    var m = raw.match(/^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})\\s*([+-]\\d{4})?/);
    if(!m) { var d = new Date(raw); return isNaN(d) ? null : d.toISOString(); }
    var off = m[7] ? (m[7].slice(0,3) + ':' + m[7].slice(3)) : 'Z';
    var d2 = new Date(m[1]+'-'+m[2]+'-'+m[3]+'T'+m[4]+':'+m[5]+':'+m[6]+off);
    return isNaN(d2) ? null : d2.toISOString();
  }
  var out = [];
  [].forEach.call(document.querySelectorAll('table tbody tr'), function(tr){
    var nameCell = tr.querySelector('.table--primaryLink');
    if(!nameCell) return;
    var name = clean(nameCell.innerText);
    if(!name) return;
    var st = tr.querySelector('[class*="submissionStatus"]');
    var status = st ? clean(st.innerText) : '';
    var link = nameCell.querySelector('a');
    out.push({
      n: name,
      d: iso(tr.querySelector('time.submissionTimeChart--dueDate')),
      o: iso(tr.querySelector('time.submissionTimeChart--releaseDate')),
      status: status,
      u: link ? link.getAttribute('href') : null
    });
  });
  return JSON.stringify({ title: document.title, items: out });
})()`;

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

function load(win, url) {
  return new Promise((r) => {
    win.webContents.once('did-finish-load', r);
    win.webContents.once('did-fail-load', r);
    win.loadURL(url);
  });
}

/**
 * @param {boolean} interactive may we show a sign-in window?
 * @param {(s:string)=>void} say progress reporter
 */
async function pull(interactive, say = () => {}) {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820, title: 'Gradescope',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const wc = win.webContents;
  const close = () => { if (!win.isDestroyed()) win.destroy(); };

  try {
    say('Checking Gradescope…');
    await load(win, HOME);

    if (!(await wc.executeJavaScript(LOGGED_IN, true).catch(() => false))) {
      if (!interactive) { close(); return { ok: false, needLogin: true }; }
      say('Sign in to Gradescope in the window that opened.');
      win.show(); win.focus();
      const ok = await waitFor(wc, LOGGED_IN, 5 * 60 * 1000);
      if (!ok) { close(); return { ok: false, error: 'sign-in was not completed' }; }
      win.hide();
    }

    const rawCourses = await wc.executeJavaScript(LIST_COURSES, true);
    let courses = [];
    try { courses = JSON.parse(rawCourses); } catch (e) { /* leave empty */ }
    if (!courses.length) { close(); return { ok: false, error: 'no Gradescope courses found' }; }

    const results = [];
    for (const c of courses) {
      say('Reading ' + (c.code || c.name) + '…');
      await load(win, 'https://www.gradescope.com' + c.href);
      const raw = await wc.executeJavaScript(READ_COURSE, true).catch(() => null);
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { /* leave null */ }
      if (parsed && parsed.items.length) {
        results.push({ code: c.code, name: c.name, href: c.href, items: parsed.items });
      }
    }

    close();
    if (!results.length) return { ok: false, error: 'no assignments found in Gradescope' };
    return { ok: true, courses: results };
  } catch (e) {
    close();
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { pull };
