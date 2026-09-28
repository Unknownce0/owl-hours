/* Runs inside a signed-in D2L page (isolated world). Reads announcements and
   the plain HTML pages in each course's Content, and returns sentences that
   pair a graded-work word with a date. Nothing is decided here: the app
   compares these against what it already knows and asks the user.
   Expects a global OU_LIST (array of org unit ids) set before it runs. */
(async function () {
  const API = '/d2l/api/le/1.67/';
  const MAX_PAGES = 60;          // per course
  const MAX_BYTES = 300000;      // skip anything bigger (embedded media, exports)
  const MO = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const WD = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

  const get = (u) => fetch(u, { credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : ''), () => '');
  const text = (html) => {
    const d = new DOMParser().parseFromString(html || '', 'text/html');
    d.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
    // keep list items and table cells apart so dates don't glue onto the wrong line
    d.querySelectorAll('li,p,div,tr,td,th,br,h1,h2,h3,h4,h5,h6').forEach((n) => n.append(' \n '));
    return (d.body ? d.body.textContent : '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  };

  const KIND = [
    ['exam', /\b(final exam|midterm|exam|test)\b/i],
    ['quiz', /\bquiz(?:zes)?\b/i],
    ['project', /\b(project|presentation|paper|essay|lab report|portfolio)\b/i],
    ['assignment', /\b(assignment|homework|hw|problem set|worksheet|lab \d+)\b/i],
  ];
  const DUEISH = /\b(due|by|on|scheduled|will (?:be|take place|have)|opens?|closes?|take|submit|turn in|deadline|in class|next)\b/i;
  const NOISE = /\b(grades? (?:are|have been) (?:posted|released)|scores?|graded|feedback|results|policy|make-?up policy|late policy|scratch paper|office hours|study guide|review for|scored|earned|out of|practice (?:quiz|test|exam))\b/i;

  const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  const RE_MD = new RegExp('\\b' + MONTH + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b', 'ig');
  const RE_NUM = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
  const RE_WD = /\b(this|next|on)?\s*(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*day\b/ig;
  const RE_TIME = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i;

  // Year-less dates get the year that lands nearest the reference date.
  function fixYear(mo, dy, ref) {
    let best = null;
    for (const y of [ref.getFullYear() - 1, ref.getFullYear(), ref.getFullYear() + 1]) {
      const d = new Date(y, mo, dy, 23, 59);
      if (!best || Math.abs(d - ref) < Math.abs(best - ref)) best = d;
    }
    return best;
  }

  function datesIn(s, ref, weekdaysOk) {
    const out = [];
    let m;
    RE_MD.lastIndex = 0;
    while ((m = RE_MD.exec(s))) {
      const mo = MO[m[1].slice(0, 3).toLowerCase()], dy = +m[2];
      if (mo !== undefined && dy >= 1 && dy <= 31) out.push({ at: m.index, d: fixYear(mo, dy, ref) });
    }
    RE_NUM.lastIndex = 0;
    while ((m = RE_NUM.exec(s))) {
      const mo = +m[1] - 1, dy = +m[2];
      if (mo < 0 || mo > 11 || dy < 1 || dy > 31) continue;
      if (/\d\s*$/.test(s.slice(0, m.index)) || /^\s*(pts|points|%)/i.test(s.slice(m.index + m[0].length))) continue; // scores like 8/10
      const d = m[3] ? new Date(+m[3] < 100 ? 2000 + +m[3] : +m[3], mo, dy, 23, 59) : fixYear(mo, dy, ref);
      out.push({ at: m.index, d });
    }
    // A bare weekday only means something relative to when it was written.
    if (weekdaysOk) {
      RE_WD.lastIndex = 0;
      while ((m = RE_WD.exec(s))) {
        const w = WD[m[2].slice(0, 3).toLowerCase()];
        const d = new Date(ref); d.setHours(23, 59, 0, 0);
        let add = (w - d.getDay() + 7) % 7;
        if (add === 0) add = 7;
        if ((m[1] || '').toLowerCase() === 'next' && add < 7) add += 7;
        d.setDate(d.getDate() + add);
        // "Thursday, October 15": the written-out date wins
        const rest = s.slice(m.index + m[0].length, m.index + m[0].length + 4);
        if (/^,?\s*(?:the\s+)?[a-z0-9]/i.test(rest) && out.some((o) => o.at > m.index && o.at - (m.index + m[0].length) <= 4)) continue;
        out.push({ at: m.index, d, rel: 1 });
      }
    }
    // "Sept 28 through Oct 4" is a window; what matters is when it closes
    out.sort((a, b) => a.at - b.at);
    for (let i = out.length - 2; i >= 0; i--) {
      const gap = s.slice(out[i].at, out[i + 1].at);
      if (/^\S+\s+\d{1,2}(?:st|nd|rd|th)?\s*(?:through|thru|to|until|-|\u2013|\u2014)\s*$/i.test(gap) ||
          /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*(?:through|thru|to|until|-|\u2013|\u2014)\s*$/i.test(gap)) out.splice(i, 1);
    }
    for (const o of out) {
      const t = s.slice(o.at, o.at + 40).match(RE_TIME);
      if (t) {
        let h = +t[1] % 12; if (/p/i.test(t[3])) h += 12;
        o.d = new Date(o.d); o.d.setHours(h, +(t[2] || 0), 0, 0); o.timed = 1;
      }
    }
    return out;
  }

  const RE_NAME = /\b((?:chapter|ch\.?|unit|module|week)\s*\d+\s+)?(final exam|midterm(?: exam)?|exam|test|quiz|project|presentation|paper|essay|lab report|lab|assignment|homework|problem set)(\s*(?:#\s*)?\d+[a-z]?(?![\/:\d]))?\b/ig;
  const KIND_OF = (w) => /exam|midterm|test/i.test(w) ? 'exam' : /quiz/i.test(w) ? 'quiz'
    : /project|presentation|paper|essay|report|portfolio/i.test(w) ? 'project' : 'assignment';
  // Every piece of work named since the previous date ("Lab 6 and
  // Assignment 3 are due on Oct 4"), or else the first one named after it.
  function namesFor(ctx, from, at) {
    const out = [];
    let after = null, m;
    RE_NAME.lastIndex = 0;
    while ((m = RE_NAME.exec(ctx))) {
      if (m.index >= from && m.index < at) out.push(m);
      else if (m.index >= at && !after) after = m;
    }
    if (!out.length && after) out.push(after);
    // "essay type quiz" is one thing, named by its last word
    const merged = [];
    out.forEach((x) => {
      const prev = merged[merged.length - 1];
      const gap = prev ? ctx.slice(prev.end, x.index) : null;
      if (prev && !prev.num && gap.length <= 10 && /^[\s\w-]*$/.test(gap) && !/\band\b|\bor\b/i.test(gap)) {
        prev.text = ctx.slice(prev.index, x.index + x[0].length); prev.end = x.index + x[0].length;
        prev.kind = KIND_OF(x[2]); prev.num = !!x[3];
      } else {
        merged.push({ text: x[0], index: x.index, end: x.index + x[0].length, kind: KIND_OF(x[2]), num: !!(x[3] || x[1]) });
      }
    });
    // a bare "lab" beside "Lab 1 and Lab 2" is just the class being mentioned
    const keep = merged.some((x) => x.num) ? merged.filter((x) => x.num) : merged.slice(-1);
    return keep.map((x) => ({
      name: x.text.replace(/\s+/g, ' ').replace(/#\s*/, '').trim()
        .replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b(Ch|Hw)\b/g, (y) => y.toUpperCase()),
      kind: x.kind,
    }));
  }

  function scanText(txt, ref, weekdaysOk, base) {
    const found = [];
    const sentences = txt.split(/(?<=[.!?])\s+|\n+/);
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i].trim();
      if (s.length < 8 || s.length > 400) continue;
      if (!KIND.some(([, re]) => re.test(s))) continue;
      if (NOISE.test(s) && !/\bdue\b/i.test(s)) continue;
      // a date may sit on the next short line (tables, lists), unless that
      // line names its own piece of work
      let ds = datesIn(s, ref, weekdaysOk), ctx = s, off = 0;
      const nx = (sentences[i + 1] || '').trim();
      if (!ds.length && nx && nx.length < 80 && !KIND.some(([, re]) => re.test(nx))) {
        off = s.length + 1; ctx = s + ' ' + nx;
        ds = datesIn(nx, ref, weekdaysOk).map((d) => Object.assign(d, { at: d.at + off }));
      }
      if (!ds.length) continue;
      if (!DUEISH.test(ctx) && ctx.length > 90) continue;   // long prose that merely mentions both
      ds.forEach((d, k) => namesFor(ctx, k ? ds[k - 1].at : 0, d.at).forEach((nm) => {
        found.push(Object.assign({}, base, {
          kind: nm.kind, name: nm.name, d: d.d.toISOString(), timed: d.timed || 0, rel: d.rel || 0,
          snippet: ctx.length > 220 ? ctx.slice(0, 217) + '\u2026' : ctx,
        }));
      }));
    }
    return found;
  }

  function walk(mods, out) {
    (mods || []).forEach((m) => {
      (m.Topics || []).forEach((t) => out.push(t));
      walk(m.Modules, out);
    });
    return out;
  }

  const ous = (typeof OU_LIST !== 'undefined' && OU_LIST) || [];
  const results = [];
  const stats = { courses: 0, announcements: 0, pages: 0 };

  await Promise.all(ous.map(async (ou) => {
    stats.courses++;
    // announcements: bare weekdays count, measured from the post date
    try {
      const arr = JSON.parse(await get(API + ou + '/news/') || '[]');
      for (const a of arr) {
        stats.announcements++;
        const ref = new Date(a.StartDate || a.CreatedDate || Date.now());
        const body = text((a.Body && (a.Body.Html || a.Body.Text)) || '');
        results.push(...scanText((a.Title || '') + '.\n' + body, ref, true,
          { ou: String(ou), src: 'announcement', where: a.Title || 'Announcement', url: '/d2l/lms/news/main.d2l?ou=' + ou, posted: ref.toISOString() }));
      }
    } catch (e) { /* no announcements tool in this course */ }

    // content pages: only HTML the course itself hosts
    try {
      const toc = JSON.parse(await get(API + ou + '/content/toc') || '{}');
      const topics = walk(toc.Modules, []).filter((t) => t.Url && /^\/content\/.*\.html?$/i.test(t.Url.split('?')[0]) && !t.IsHidden);
      const now = new Date();
      for (const t of topics.slice(0, MAX_PAGES)) {
        const html = await get(encodeURI(t.Url));
        if (!html || html.length > MAX_BYTES) continue;
        stats.pages++;
        results.push(...scanText(text(html), now, false,
          { ou: String(ou), src: 'page', where: t.Title || 'Course page', url: '/d2l/le/content/' + ou + '/viewContent/' + t.TopicId + '/View' }));
      }
    } catch (e) { /* content unavailable */ }
  }));

  return JSON.stringify({ results, stats });
})();
