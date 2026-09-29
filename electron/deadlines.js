/* Reads the text the scanner collected (announcements, class pages) and pulls
   out claims about when work happens: "Your first Movement Activity is due this
   Sunday", "Test 1 will be on Oct 6 at 2:20 PM", "Take the Respondus set up
   quiz before you take the Test 1".

   Dates come from chrono (a natural-language date parser), read relative to
   when the announcement was posted, so "this Sunday" means the Sunday after
   the post, not after today. Deciding whether a claim is new, already known,
   or disagrees with D2L happens in the app, which knows the user's items. */
const chrono = require('chrono-node');

const WORK = '(?:final exam|midterm(?: exam)?|exam|test|quiz(?:zes)?|assignments?|homework|hw|labs?|lab report|projects?|papers?|essays?|reports?|presentations?|discussion(?: board| post)?|initial post|repl(?:y|ies)|journal(?: entry| reflection)?|reflections?|activit(?:y|ies)|videos?|worksheets?|problem sets?|drafts?|proposals?|portfolios?|surveys?|set ?up quiz|readings?)';
const RE_WORK = new RegExp('\\b' + WORK + '\\b', 'i');
// up to three describing words, the work word, and an optional number
const RE_PHRASE = new RegExp("((?:[A-Za-z0-9][\\w'’-]*\\s+){0,3}?)(" + WORK + ")(\\s*(?:#\\s*)?\\d+[a-z]?(?![\\/:\\d]))?\\b", 'ig');

const CUE = /\b(due|deadline|submit(?:ted)?|turn(?:ed)? in|upload|complete|finish|take|will be (?:on|held|given)|is on|opens?|closes?|before|by|no later than)\b/i;
const NOISE = /\b(grades? (?:are|have been|were) (?:posted|released)|scored|earned|out of|graded|feedback|office hours|tutoring|workshop|meets on|class meets|scratch paper|study guide|practice (?:quiz|test|exam))\b/i;

const LEAD = new Set(['a', 'an', 'the', 'your', 'our', 'my', 'this', 'that', 'these', 'those', 'all', 'each', 'every', 'any',
  'of', 'for', 'and', 'or', 'to', 'in', 'on', 'take', 'complete', 'finish', 'submit', 'do', 'start', 'is', 'are', 'will', 'be',
  'new', 'please', 'then', 'also', 'must', 'should', 'you', 'we', 'i', 'it', 'upcoming', 'following', 'weekly', 'normal']);
const ORDINAL = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, next: 'next', last: 'last', final: 'last' };

function sentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 450);
}

/* "Your first Movement Activity" → { name: "Movement Activity", ordinal: 1 } */
function tidy(m) {
  let words = (m[1] || '').trim().split(/\s+/).filter(Boolean);
  let ordinal = null;
  words = words.filter((w) => {
    const lw = w.toLowerCase().replace(/[^\w]/g, '');
    if (ORDINAL[lw] !== undefined) { ordinal = ORDINAL[lw]; return false; }
    return true;
  });
  const before = words.length;
  while (words.length && LEAD.has(words[0].toLowerCase().replace(/[^\w]/g, ''))) words.shift();
  const loose = words.length !== before || ordinal !== null;
  const name = (words.join(' ') + ' ' + m[2] + (m[3] || '')).replace(/\s+/g, ' ').replace(/#\s*/, '').trim();
  return { name: name.replace(/\b\w/g, (c) => c.toUpperCase()), ordinal, loose, at: m.index, end: m.index + m[0].length };
}

function phrases(s) {
  const out = [];
  let m;
  RE_PHRASE.lastIndex = 0;
  while ((m = RE_PHRASE.exec(s))) {
    const p = tidy(m), prev = out[out.length - 1];
    // "an essay type quiz" is one thing, not an essay and a quiz
    if (prev && !p.loose && !/\d/.test(prev.name) && /^\s*$/.test(s.slice(prev.end, m.index))) {
      prev.name = prev.name + ' ' + p.name; prev.end = p.end;
      if (p.ordinal) prev.ordinal = p.ordinal;
    } else out.push(p);
  }
  return out;
}

/* chrono's results, cleaned: ranges become their end, a time on its own attaches
   to the date before it, "midnight" means the end of that day, and a date with
   no time means the end of the day, which is how deadlines are usually meant. */
function datesIn(s, ref, weekdaysOk = true) {
  const raw = chrono.parse(s, ref, { forwardDate: true });
  const out = [];
  for (const r of raw) {
    // a bare "Sunday" in a syllabus page has no post date to count from
    if (!weekdaysOk && !/\d|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(r.text)) continue;
    // "this week" or "tonight" alone is too vague to be a deadline
    if (!/\d|\b(mon|tue|wed|thu|fri|sat|sun)|today|tomorrow/i.test(r.text)) continue;
    // "10 minutes and 39 seconds long" is a length, not a date
    if (/\b(minutes?|mins?|seconds?|secs?|hours?|hrs?|days?|weeks?)\b/i.test(r.text) && !/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)/i.test(r.text)) continue;
    // a range across days ends when it closes; "2:20 – 3:50 PM" starts at 2:20
    const sameDay = r.end && r.end.date().toDateString() === r.start.date().toDateString();
    const c = r.end && !sameDay ? r.end : r.start;
    const hasDay = r.start.isCertain('day') || r.start.isCertain('weekday');
    const midnight = /midnight/i.test(r.text);
    if (!hasDay) {
      // "…is due Wednesday by midnight" arrives as two pieces: give the day its time
      const prev = out[out.length - 1];
      if (prev && c.isCertain('hour') && r.index - prev.endAt <= 6) {
        const d = new Date(prev.d);
        if (midnight) d.setHours(23, 59, 0, 0); else d.setHours(c.get('hour'), c.get('minute') || 0, 0, 0);
        prev.d = d; prev.timed = 1; prev.endAt = r.index + r.text.length;
      }
      continue;
    }
    const d = c.date();
    let timed = c.isCertain('hour') ? 1 : 0;
    // "midnight on Sunday" and "Sunday" alone both mean the end of Sunday
    if (midnight) { d.setHours(23, 59, 0, 0); timed = 1; }
    else if (!timed) d.setHours(23, 59, 0, 0);
    out.push({ d, timed, at: r.index, endAt: r.index + r.text.length, text: r.text });
  }
  return out;
}

function analyze(docs) {
  const out = [];
  for (const doc of docs || []) {
    const ref = new Date(doc.posted || Date.now()), dated = !!doc.posted;
    const sents = sentences(doc.text);
    sents.forEach((s, i) => {
      if (!RE_WORK.test(s) || NOISE.test(s)) return;
      const base = { ou: doc.ou, src: doc.src, where: doc.where, url: doc.url || null, posted: ref.toISOString(),
                     snippet: s.length > 230 ? s.slice(0, 227) + '…' : s };
      let ds = datesIn(s, ref, dated);
      const ph = phrases(s);
      if (!ph.length) return;

      // "Take the Respondus set up quiz … before you take the Test 1": a task
      // whose deadline is another piece of work
      const bm = s.match(new RegExp('\\bbefore (?:you (?:take|start|begin|attempt) )?(?:the |your )?((?:[A-Za-z][\\w\'’-]*\\s+){0,2}?' + WORK + '(?:\\s*#?\\s*\\d+[a-z]?)?)', 'i'));
      if (bm && !ds.some((d) => d.at > bm.index)) {
        const target = phrases(bm[1])[0];
        const task = ph.find((p) => p.end <= bm.index && target && p.name.toLowerCase() !== target.name.toLowerCase());
        if (task && target) {
          out.push(Object.assign({}, base, { kind: 'before', name: task.name, ordinal: task.ordinal, before: target.name }));
        }
        return;
      }

      // a short line with a date on its own right after ("Chapter 4 Quiz" / "10/12")
      if (!ds.length && sents[i + 1] && sents[i + 1].length < 60 && !RE_WORK.test(sents[i + 1])) {
        ds = datesIn(sents[i + 1], ref, dated).map((d) => Object.assign(d, { at: d.at + s.length + 1 }));
      }
      if (!ds.length) return;
      if (!CUE.test(s) && s.length > 110) return;   // long prose that merely mentions both

      ds.forEach((d, k) => {
        const from = k ? ds[k - 1].endAt : 0;
        let named = ph.filter((p) => p.at >= from && p.at < d.at);
        if (!named.length) named = ph.filter((p) => p.at >= d.endAt).slice(0, 1);
        // "Lab 1 and Lab 2 for your lab class": a bare word next to numbered ones is just talk
        if (named.some((p) => /\d/.test(p.name))) named = named.filter((p) => /\d/.test(p.name));
        else named = named.slice(-1);
        named.forEach((p) => out.push(Object.assign({}, base, {
          kind: 'due', name: p.name, ordinal: p.ordinal, d: d.d.toISOString(), timed: d.timed,
        })));
      });
    });
  }
  return out;
}

module.exports = { analyze, datesIn, phrases, sentences };
