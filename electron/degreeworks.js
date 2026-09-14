/* Reading the degree audit out of DegreeWorks.
 *
 * DegreeWorks is an Ellucian app and, unlike D2L, it hands out clean JSON:
 * /api/students/myself names you and your goal (school + degree + catalog year),
 * and /api/audit returns the whole audit as structured data. So there is no
 * HTML scraping here at all — no selectors to rot.
 *
 * PRIVACY: the raw audit carries the student's name, KSU id, email and home
 * phone numbers. None of that is needed to draw a degree map, so this module
 * never returns it. Only course codes, grades, credits and completion
 * percentages leave this file. Keep it that way — verify-build.sh checks that
 * audit data never reaches the public repo, but it cannot check what we chose
 * to put in the object in the first place.
 */
const { BrowserWindow } = require('electron');

const PARTITION = 'persist:d2l';        // one signed-in Kennesaw profile for everything
const HOME = 'https://degreeworks.kennesaw.edu/worksheets/WEB31';

const LOGGED_IN = "location.hostname === 'degreeworks.kennesaw.edu'";

/* Pull the audit and hand back only the parts we actually draw.
   Runs in the page so the session cookies come along for free. */
const READ_AUDIT = `(async function(){
  function j(url){
    return fetch(url, {credentials:'include', headers:{Accept:'application/json'}})
      .then(function(r){ return r.ok ? r.text() : ''; })
      .then(function(t){ try { return JSON.parse(t); } catch(e){ return null; } });
  }
  var me = await j('/api/students/myself');
  var stu = me && me._embedded && me._embedded.students && me._embedded.students[0];
  if(!stu || !stu.goals || !stu.goals.length) return 'ERROR:NOSTUDENT';

  var goal = stu.goals[0];
  var q = '/api/audit?studentId=' + encodeURIComponent(stu.id)
        + '&school='  + encodeURIComponent(goal.school.key)
        + '&degree='  + encodeURIComponent(goal.degree.key)
        + '&is-process-new=false&audit-type=AA&auditId='
        + '&include-inprogress=true&include-preregistered=true&aid-term=';
  var a = await j(q);
  if(!a || !a.auditHeader) return 'ERROR:NOAUDIT';

  function num(v){ var n = parseFloat(v); return isFinite(n) ? n : 0; }

  /* One row per course on the record. letterGrade "REGD" means registered —
     that is this term's work, not something finished. */
  var classes = (a.classInformation && a.classInformation.classArray || []).map(function(c){
    var grade = (c.letterGrade || '').trim();
    return {
      code: (c.discipline || '') + ' ' + (c.number || ''),
      title: c.courseTitle || '',
      credits: num(c.credits),
      grade: grade,
      inProgress: c.inProgress === 'Y' || grade === 'REGD',
      passed: c.passed === 'Y',
      /* Genuine transfer credit is transfer "T" / transferCode "TR". A plain
         KSU course record carries "C", which is not a transfer — testing for
         "anything but N" marked every course on the record as transferred. */
      transfer: String(c.transfer || '').trim() === 'T',
      term: c.term || '',
      termName: c.termLiteral || ''
    };
  });

  var blocks = (a.blockArray || []).map(function(b){
    return {
      title: (b.title || '').trim(),
      type: b.requirementType || '',
      pct: num(b.percentComplete),
      credits: num(b.creditsApplied)
    };
  });

  var major = blocks.filter(function(b){ return b.type === 'MAJOR'; })[0];

  return JSON.stringify({
    degree: (goal.degree && goal.degree.description) || '',
    program: major ? major.title.replace(/^Major in\\s+/i, '') : '',
    catalogYear: goal.catalogYear || '',
    level: (goal.level || ''),
    activeTerm: stu.activeTerm || '',
    percentComplete: num(a.auditHeader.percentComplete),
    gpa: (a.auditHeader.degreeworksGpa || '').trim(),
    transferCredits: num(a.auditHeader.transferApplied),
    blocks: blocks,
    classes: classes,
    scrapedAt: new Date().toISOString()
  });
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
    let settled = false;
    const done = () => { if (!settled) { settled = true; r(); } };
    win.webContents.once('did-finish-load', done);
    win.webContents.once('did-fail-load', done);
    setTimeout(done, 30000);
    win.loadURL(url);
  });
}

/**
 * @param {boolean} interactive  may we show a sign-in window?
 * @param {(s:string)=>void} say progress reporter
 */
async function pull(interactive, say = () => {}) {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 840, title: 'DegreeWorks',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const wc = win.webContents;
  const close = () => { if (!win.isDestroyed()) win.destroy(); };

  try {
    say('Checking DegreeWorks…');
    await load(win, HOME);

    // Bounced to Microsoft single sign-on means the Kennesaw session has lapsed.
    if (!(await wc.executeJavaScript(LOGGED_IN, true).catch(() => false))) {
      if (!interactive) { close(); return { ok: false, needLogin: true }; }
      say('Sign in to KSU in the window that opened.');
      win.show(); win.focus();
      const ok = await waitFor(wc, LOGGED_IN, 5 * 60 * 1000);
      if (!ok) { close(); return { ok: false, error: 'sign-in was not completed' }; }
      win.hide();
      // the dashboard boots its own session after the redirect; let it settle
      await new Promise((r) => setTimeout(r, 2500));
    }

    say('Reading your audit…');
    const raw = await wc.executeJavaScript(READ_AUDIT, true).catch((e) => 'ERROR:' + e.message);
    close();

    if (typeof raw !== 'string') return { ok: false, error: 'unexpected reply from DegreeWorks' };
    if (raw === 'ERROR:NOSTUDENT') return { ok: false, needLogin: true };
    if (raw.startsWith('ERROR:')) return { ok: false, error: raw.slice(6) };

    let audit;
    try { audit = JSON.parse(raw); } catch (e) { return { ok: false, error: 'could not read the audit' }; }
    if (!audit.classes || !audit.classes.length) return { ok: false, error: 'the audit came back empty' };
    return { ok: true, audit };
  } catch (e) {
    close();
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { pull };
