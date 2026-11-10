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
const remote = require('./remote');         // one signed-in profile for everything

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

/* The assignment table, read from a document: the loaded page, or a course
   page fetched and parsed without being shown. Same code for both, so the two
   routes can't drift apart. */
const READ_DOC = `function(document){
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
  return { title: document.title, items: out };
}`;

/** The assignment table for one course (the page this window has open). */
const READ_COURSE = `JSON.stringify((${READ_DOC})(document))`;

/* Every course at once, from the account page: fetch each course page and
   parse it, rather than loading them one after another in the window. */
function readAll(courses) {
  return `(function(){
    var read = ${READ_DOC};
    var list = ${JSON.stringify(courses)};
    return Promise.all(list.map(function(c){
      return fetch(c.href, { credentials: 'same-origin' })
        .then(function(r){ return r.ok ? r.text() : ''; })
        .then(function(html){
          if (!html) return null;
          var r = read(new DOMParser().parseFromString(html, 'text/html'));
          /* The page's own script sorts the table once it renders: latest due
             first, then latest release, ties in page order. A parsed copy is
             never rendered, so sort it the same way to keep the same rows in
             the same order as a loaded page. */
          var t = function(s){ return s ? Date.parse(s) : -Infinity; };
          r.items.sort(function(a, b){ return (t(b.d) - t(a.d)) || (t(b.o) - t(a.o)); });
          return r;
        })
        .catch(function(){ return null; });
    })).then(function(r){ return JSON.stringify(r); });
  })()`;
}

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

const load = (win, url) => remote.load(win, url);

/**
 * @param {boolean} interactive may we show a sign-in window?
 * @param {(s:string)=>void} say progress reporter
 */
async function pull(interactive, say = () => {}) {
  const win = remote.open({ width: 1100, height: 820, title: 'Gradescope' });
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

    let results = [];
    say('Reading ' + courses.length + ' Gradescope course' + (courses.length === 1 ? '' : 's') + '…');
    const fast = await wc.executeJavaScript(readAll(courses), true).catch(() => null);
    let parsedAll = null;
    try { parsedAll = JSON.parse(fast); } catch (e) { /* fall back below */ }
    (parsedAll || []).forEach((p, k) => {
      if (p && p.items && p.items.length) {
        const c = courses[k];
        results.push({ code: c.code, name: c.name, href: c.href, items: p.items });
      }
    });

    /* If the quick route found nothing, read the old way, one page at a time. */
    if (!results.length) for (const c of courses) {
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

module.exports = { pull, READ_DOC };
