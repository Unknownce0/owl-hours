const test = require('node:test');
const assert = require('node:assert/strict');
const deadlines = require('../electron/deadlines');

const day = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];

test('"due this Sunday" counts from the post date, not today (DANC Movement Activity)', () => {
  const r = deadlines.analyze([{
    ou: '1', src: 'announcement', where: 'Week 7',
    posted: new Date(2026, 8, 29, 10, 0).toISOString(),     // Tue Sep 29 2026
    text: 'Week 7.\nYour first Movement Activity is due this Sunday.'
  }]);
  const hit = r.find((x) => x.kind === 'due' && /Movement Activity/.test(x.name));
  assert.ok(hit, 'found the Movement Activity');
  assert.deepEqual(day(new Date(hit.d)), [2026, 10, 4]);
  assert.equal(hit.ordinal, 1);
});

test('"Tuesday 13th" with no month gets the next 13th that is a Tuesday', () => {
  const ref = new Date(2026, 9, 1, 9, 0);                    // Thu Oct 1 2026
  const ds = deadlines.datesIn('The midterm is on Tuesday 13th in class.', ref);
  assert.equal(ds.length, 1);
  assert.deepEqual(day(ds[0].d), [2026, 10, 13]);
});

test('a date with no time means the end of that day', () => {
  const ds = deadlines.datesIn('Lab 6 is due Oct 4', new Date(2026, 8, 20));
  assert.equal(ds[0].d.getHours(), 23);
  assert.equal(ds[0].d.getMinutes(), 59);
});

test('"before you take the Test 1" makes a do-first task', () => {
  const r = deadlines.analyze([{
    ou: '1', src: 'announcement', where: 'x', posted: new Date(2026, 9, 1).toISOString(),
    text: 'Take the Respondus set up quiz before you take the Test 1.'
  }]);
  const b = r.find((x) => x.kind === 'before');
  assert.ok(b);
  assert.match(b.before, /Test 1/);
});

test('a length is not a date', () => {
  assert.equal(deadlines.datesIn('The video is 10 minutes and 39 seconds long', new Date(2026, 8, 1)).length, 0);
});
