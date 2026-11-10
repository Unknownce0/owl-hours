/* Turning what each reader returned into Owl Hours rows.
 *
 * Kept apart from main.js, with no Electron in it, so the rules that have
 * broken before (what counts as done, which calendar entries are noise) can be
 * tested with plain node. Every row is flagged x:1 so a D2L refresh keeps it.
 */

/** A timed sitting rather than a deadline: a real span, not a single instant. */
function isScheduled(ev) {
  if (!ev.start || !ev.end) return false;
  const a = Date.parse(ev.start), b = Date.parse(ev.end);
  return isFinite(a) && isFinite(b) && (b - a) >= 60000;
}

/** Gradescope courses -> rows. */
function gradescope(res) {
  /* Once graded, Gradescope replaces the status with the score itself
     ("105.0 / 100.0"). Saved verbatim, no rule recognised it as done. */
  const score = (st) => String(st || '').match(/^\s*(-?[\d.]+)\s*\/\s*([\d.]+)\s*$/);
  const courses = res.courses.map((c) => ({
    code: c.code,
    name: c.name,
    items: c.items.map((i) => { const sc = score(i.status); return {
      t: 'a',
      n: i.n + '  (Gradescope)',
      d: i.d || undefined,
      o: i.o || undefined,
      s: sc ? 'Graded' : /no submission/i.test(i.status) ? 'Not Submitted' : (i.status || 'Submitted'),
      e: sc ? +sc[1] : undefined,
      p: sc ? +sc[2] : undefined,
      u: i.u ? 'https://www.gradescope.com' + i.u : 'https://www.gradescope.com' + c.href,
      x: 1,
      src: 'gs'
    }; })
  }));
  return courses;
}

/* The calendar carries the things that are never submitted anywhere — most
   importantly sit-down exams. Shaped like every other row so the agenda and
   calendar views need no special case. */
function calendar(res) {
  /* Courses bulk-stamp their content modules onto the calendar: DANC 1107 has
     fourteen "Week N - <topic>" entries all sharing one timestamp near the end
     of term. Those are availability markers, not deadlines, and adding them
     would drop fourteen rows onto a single December day. A timestamp shared by
     five or more events in one course is that pattern, never five real
     deadlines that happen to coincide. */
  const stamp = {};
  res.events.forEach((ev) => {
    const k = ev.ou + '|' + ev.start + '|' + ev.end;
    stamp[k] = (stamp[k] || 0) + 1;
  });

  /* Exact-match alone was not enough. COMM 1100 carries fifteen textbook
     chapter entries stamped 2:53 to 2:56 one afternoon — bulk-added a minute
     apart as the instructor clicked through, so no two share an instant and
     all fifteen sailed past the filter into the agenda as overdue work.
     The tell is the spread itself: real deadlines in a course land on the
     same instant (11:59pm), while bulk-stamped content dribbles across a few
     minutes. So: five or more in one course inside a quarter hour, not all at
     the same moment. */
  const byCourse = {};
  res.events.forEach((ev) => {
    const t = Date.parse(ev.start);
    if (!isFinite(t)) return;
    (byCourse[ev.ou] = byCourse[ev.ou] || []).push(t);
  });
  const WINDOW = 15 * 60 * 1000;
  const smeared = (ev) => {
    const t = Date.parse(ev.start);
    if (!isFinite(t)) return false;
    const near = (byCourse[ev.ou] || []).filter((x) => Math.abs(x - t) <= WINDOW);
    if (near.length < 5) return false;
    return near.some((x) => x !== t);      // spread, not one shared deadline
  };

  const bulk = (ev) => stamp[ev.ou + '|' + ev.start + '|' + ev.end] >= 5 || smeared(ev);

  /* An event attached to a quiz, dropbox or discussion is only that item's due
     date — the item itself is already on the page with its real done status.
     Adding the calendar copy too gave a second row with no status, which read
     as overdue forever: COMM's "Unit 1"/"Unit 2" were exactly that. Events
     attached to content pages are reading markers. What is left, attached to
     nothing, is a sit-down exam: the one thing only the calendar knows. */
  const items = res.events.filter((ev) => !ev.entity && !bulk(ev)).map((ev) => {
    const timed = isScheduled(ev);
    const isExam = /\b(exam|midterm|final|test)\b/i.test(ev.n);
    return {
      ou: ev.ou,
      t: isExam ? 'q' : 'a',
      /* For something you sit at a fixed hour, the moment that matters is when
         it starts, not when it ends. For a deadline the end is the deadline. */
      d: timed ? ev.start : (ev.end || ev.start),
      n: ev.n + (timed ? '  (scheduled)' : ''),
      /* A calendar entry carries no submission state — there is nothing to
         submit to. Claiming "Not Submitted" invented a fact and painted work
         already finished as outstanding. Leave it blank; the tick box is
         there for anyone who wants to mark it off. */
      where: ev.where || undefined,
      /* kept so the page can show the whole window and know when it is over */
      end: timed ? ev.end : undefined,
      timed: timed ? 1 : undefined,
      exam: isExam ? 1 : undefined,
      x: 1,
      src: 'cal'
    };
  });
  return items;
}

/** ALEKS courses -> rows. now is injectable for tests. */
function aleks(res, now = Date.now()) {
  // shape ALEKS rows like everything else, flagged x:1 so a D2L refresh keeps them
  const courses = res.courses.map((c) => ({
    ou: c.ou,
    items: c.items.map((i) => {
      /* "Closed" is the deadline having passed, NOT the work being finished —
         an assignment never started reads Closed the moment it is late, so
         this was marking missed work as complete. ALEKS states its real
         answer in the progress column and the "N out of N topics completed"
         detail behind it. */
      const tp = String(i.details || '').match(/(\d+)\s+out of\s+(\d+)\s+topics completed/i);
      /* A test or knowledge check is one sitting: any recorded result means it
         was taken. Requiring 100% marked a sat test as "Not Submitted". */
      const oneSitting = /quiz|test|exam|knowledge check/i.test((i.type || '') + ' ' + (i.n || ''));
      const done = oneSitting
        ? (i.pct != null && i.pct > 0) || /submitted|completed/i.test(i.status || '')
        : i.pct === 100 || !!(tp && +tp[2] > 0 && tp[1] === tp[2]);
      /* ALEKS submits whatever is done when the deadline hits, so past the due
         date any progress is a submitted score (70% is a grade, not a miss).
         Only 0% past the deadline is actually missed. */
      const pastDue = !!(i.d && Date.parse(i.d) < now);
      const autoSubmitted = !done && pastDue && i.pct != null && i.pct > 0;
      return {
        t: /quiz|test|exam/i.test(i.type) ? 'q' : 'a',
        n: i.n + '  (ALEKS)',
        d: i.d || undefined,
        o: i.o || undefined,
        s: done ? 'Completed' : autoSubmitted ? 'Submitted' : 'Not Submitted',
        e: i.pct != null ? i.pct : undefined,
        p: i.pct != null ? 100 : undefined,
        x: 1,
        src: 'aleks'
      };
    })
  }));
  return courses;
}

module.exports = { isScheduled, gradescope, calendar, aleks };
