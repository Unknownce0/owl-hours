/* Prerequisites, out of the KSU course catalog.
 *
 * The catalog is an Acalog install (catoid 84). Two useful endpoints:
 *   content.php?...&filter[cpage]=N   32 pages, ~100 courses each, giving
 *                                     "CODE: Title" and the internal coid
 *   ajax/preview_course.php?coid=N    one course, with its prerequisite text
 *
 * So the index is built once (~3200 courses, ~65KB) and cached by the caller;
 * only the courses actually on a student's map need the second request.
 *
 * The prerequisite text is not a list — it is a boolean expression with nested
 * groups, and it has to be parsed as one:
 *
 *   CS 3305:  ( MATH 2345 or CSE 2300 ) and (( CSE 1322 and CSE 1322L ),
 *             or MTRE 2710 with a "B" or higher, or CPE 3000 with a "B" or higher)
 *
 * Note the trap in that line: "B" or higher contains the word "or". Splitting
 * on and/or would read it as another branch and quietly decide the student is
 * eligible. Grade phrases are therefore stripped before tokenising, and the
 * grade they carry is attached to the course it qualifies.
 */
const { BrowserWindow } = require('electron');

const HOST = 'https://catalog.kennesaw.edu';
const CATOID = 84;
const LIST_PAGES = 32;

/* ---------- prerequisite expression parsing ---------- */

const COURSE_RE = /\b([A-Z]{2,5})\s*(\d{3,4}[A-Z]?)\b/g;

function decode(s) {
  return String(s || '')
    .replace(/&#8220;|&#8221;|&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Pull grade conditions out before anything tries to read and/or.
   Returns the cleaned text plus a map of course -> required grade. */
function liftGrades(text) {
  const grades = {};
  let t = text;

  // "A grade of "B" or better in both CSE 1322 and CSE 1322L"
  t = t.replace(/\ba grade of\s*"?([A-D])"?\s*or\s*(?:better|higher)\s*in\s*(?:both\s*|each\s*of\s*)?/gi,
    (_m, g) => { grades.__all = g; return ''; });

  // "MTRE 2710 with a "B" or higher"  — attach to the code just before it
  t = t.replace(/([A-Z]{2,5}\s*\d{3,4}[A-Z]?)\s*with\s*(?:a|an)\s*"?([A-D])"?\s*or\s*(?:higher|better)/gi,
    (_m, code, g) => { grades[code.replace(/\s+/g, ' ').trim()] = g; return code; });

  // any leftover bare grade phrase
  t = t.replace(/\bwith\s*(?:a|an)\s*"?([A-D])"?\s*or\s*(?:higher|better)/gi, '');

  return { text: t, grades };
}

/** Tokens: course codes, parentheses, and the two operators. */
function tokenize(text) {
  const out = [];
  const re = /\(|\)|\b(?:and|or)\b|[A-Z]{2,5}\s*\d{3,4}[A-Z]?/gi;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0].trim();
    if (raw === '(' || raw === ')') out.push({ t: raw });
    else if (/^and$/i.test(raw)) out.push({ t: 'and' });
    else if (/^or$/i.test(raw)) out.push({ t: 'or' });
    else out.push({ t: 'course', code: raw.replace(/\s+/g, ' ').toUpperCase() });
  }
  return out;
}

/* expr := term ("or" term)*      term := factor ("and" factor)*
   factor := "(" expr ")" | course
   Anything unparseable yields null, and the caller falls back to showing the
   raw text rather than pretending to know the answer. */
function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];

  function factor() {
    const tk = peek();
    if (!tk) return null;
    if (tk.t === '(') {
      i++;
      const e = expr();
      if (peek() && peek().t === ')') i++;
      return e;
    }
    if (tk.t === 'course') { i++; return { course: tk.code }; }
    i++;                                   // stray operator; skip it
    return null;
  }
  function term() {
    const kids = [];
    let f = factor();
    if (f) kids.push(f);
    while (peek() && peek().t === 'and') { i++; const n = factor(); if (n) kids.push(n); }
    return kids.length === 0 ? null : (kids.length === 1 ? kids[0] : { op: 'and', kids });
  }
  function expr() {
    const kids = [];
    let t = term();
    if (t) kids.push(t);
    while (peek() && peek().t === 'or') { i++; const n = term(); if (n) kids.push(n); }
    return kids.length === 0 ? null : (kids.length === 1 ? kids[0] : { op: 'or', kids });
  }

  const tree = expr();
  return i >= tokens.length - 1 ? tree : tree;   // trailing junk is tolerated
}

/** "Prerequisite: X  Concurrent: Y" -> the two clauses, separately. */
function splitClauses(text) {
  const t = decode(text);
  const pre = t.match(/prerequisites?\s*:?\s*([\s\S]*?)(?=\bconcurrent|\bcorequisites?\b|$)/i);
  const con = t.match(/(?:concurrent|corequisites?)\s*:?\s*([\s\S]*)$/i);
  return {
    prereqText: pre ? pre[1].replace(/\.$/, '').trim() : '',
    concurrentText: con ? con[1].replace(/\.$/, '').trim() : ''
  };
}

function buildTree(clause) {
  if (!clause) return null;
  const { text, grades } = liftGrades(clause);
  const tree = parse(tokenize(text));
  if (tree && grades.__all) {
    (function mark(n) {
      if (!n) return;
      if (n.course) n.grade = grades.__all;
      (n.kids || []).forEach(mark);
    })(tree);
    delete grades.__all;
  }
  if (tree) {
    (function mark(n) {
      if (!n) return;
      if (n.course && grades[n.course]) n.grade = grades[n.course];
      (n.kids || []).forEach(mark);
    })(tree);
  }
  return tree;
}

/** Parse one course's prerequisite blob into something evaluable. */
function parsePrereq(raw) {
  const { prereqText, concurrentText } = splitClauses(raw);
  return {
    prereqText,
    concurrentText,
    prereq: buildTree(prereqText),
    concurrent: buildTree(concurrentText)
  };
}

/* ---------- fetching ---------- */

const INDEX_JS = `(async function(){
  var base = '/content.php?catoid=${CATOID}&navoid=9372&filter%5Bitem_type%5D=3&filter%5Bonly_active%5D=1&filter%5B3%5D=1&filter%5Bcpage%5D=';
  var idx = {}, pages = [];
  for (var p = 1; p <= ${LIST_PAGES}; p++) pages.push(p);
  for (var i = 0; i < pages.length; i += 8) {
    await Promise.all(pages.slice(i, i + 8).map(async function(p){
      var h = await (await fetch(base + p, {credentials:'include'})).text();
      var re = /coid=(\\d+)[^>]*>\\s*([A-Z]{2,5})\\s*(\\d{3,4}[A-Z]?)\\s*:/g, m;
      while ((m = re.exec(h))) idx[m[2] + ' ' + m[3]] = m[1];
    }));
  }
  return JSON.stringify(idx);
})()`;

function coursesJS(coids) {
  return `(async function(){
    var want = ${JSON.stringify(coids)};
    var out = {};
    for (var i = 0; i < want.length; i += 6) {
      await Promise.all(want.slice(i, i + 6).map(async function(e){
        var h = await (await fetch('/ajax/preview_course.php?catoid=${CATOID}&coid=' + e[1] + '&show', {credentials:'include'})).text();
        var t = h.replace(/<script[\\s\\S]*?<\\/script>/g, '')
                 .replace(/<[^>]+>/g, ' ')
                 .replace(/\\s+/g, ' ');
        var m = t.match(/((?:Pre|Co)requisite[\\s\\S]*?)(?:Description|Credit Hours|$)/i);
        out[e[0]] = m ? m[1].trim() : '';
      }));
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

function hidden() {
  return new BrowserWindow({
    show: false, width: 1100, height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
}

/**
 * Prerequisites for a set of course codes.
 * @param {string[]} codes  e.g. ["CS 3305", "CSE 1322"]
 * @param {object|null} cachedIndex  previous code->coid map, to skip the crawl
 * @param {(s:string)=>void} say
 */
async function prereqs(codes, cachedIndex, say = () => {}) {
  const win = hidden();
  const close = () => { if (!win.isDestroyed()) win.destroy(); };
  try {
    await load(win, HOST + '/content.php?catoid=' + CATOID + '&navoid=9372');

    let index = cachedIndex;
    if (!index || !Object.keys(index).length) {
      say('Reading the course catalog…');
      const raw = await win.webContents.executeJavaScript(INDEX_JS, true);
      try { index = JSON.parse(raw); } catch (e) { index = null; }
      if (!index || !Object.keys(index).length) { close(); return { ok: false, error: 'could not read the catalog index' }; }
    }

    const pairs = codes
      .map((c) => [c, index[c]])
      .filter((p) => p[1]);

    say('Checking prerequisites…');
    const rawCourses = await win.webContents.executeJavaScript(coursesJS(pairs), true);
    close();

    let blobs = {};
    try { blobs = JSON.parse(rawCourses); } catch (e) { /* leave empty */ }

    const courses = {};
    Object.keys(blobs).forEach((code) => { courses[code] = parsePrereq(blobs[code]); });
    // Courses with no catalog entry at all still deserve a slot, so the UI can
    // say "not in the catalog" rather than silently implying no prerequisites.
    codes.forEach((c) => { if (!(c in courses)) courses[c] = { missing: true }; });

    return { ok: true, index, courses, scrapedAt: new Date().toISOString() };
  } catch (e) {
    close();
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { prereqs, parsePrereq };
