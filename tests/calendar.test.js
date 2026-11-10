require('./electron-stub');
const test = require('node:test');
const assert = require('node:assert/strict');
const calendar = require('../electron/calendar');
const shape = require('../electron/shape');

const ev = (o) => Object.assign({ ou: '1', n: 'Thing', start: '2026-10-29T03:59:59Z', end: '2026-10-29T03:59:59Z', entity: null, where: '' }, o);

test('isScheduled: a real span is a sitting, a single instant is a deadline', () => {
  assert.equal(calendar.isScheduled({ start: '2026-10-29T16:45:00Z', end: '2026-10-29T17:40:00Z' }), true);
  assert.equal(calendar.isScheduled({ start: '2026-10-29T03:59:59Z', end: '2026-10-29T03:59:59Z' }), false);
  assert.equal(calendar.isScheduled({ start: '2026-10-29T03:59:00Z', end: '2026-10-29T03:59:30Z' }), false);
  assert.equal(calendar.isScheduled({ start: null, end: '2026-10-29T03:59:59Z' }), false);
  assert.equal(calendar.isScheduled({ start: 'garbage', end: 'garbage' }), false);
});

test('interpret: every course failing is an error, never ok with no events', () => {
  const r = calendar.interpret(JSON.stringify({ events: [], read: [], failed: ['1', '2'] }));
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(calendar.interpret('not json').ok, false);
  const good = calendar.interpret(JSON.stringify({ events: [], read: ['1'], failed: ['2'] }));
  assert.equal(good.ok, true);
  assert.deepEqual(good.read, ['1']);
  assert.deepEqual(good.failed, ['2']);
});

test('bulk filter: five entries on one instant in a course are dropped', () => {
  const events = [1, 2, 3, 4, 5].map((k) => ev({ n: 'Week ' + k + ' - Topic', start: '2026-12-10T05:00:00Z', end: '2026-12-10T05:00:00Z' }));
  assert.equal(shape.calendar({ events }).length, 0);
});

test('bulk filter: four on one instant are kept (real deadlines can coincide)', () => {
  const events = [1, 2, 3, 4].map((k) => ev({ n: 'Exam ' + k }));
  assert.equal(shape.calendar({ events }).length, 4);
});

test('bulk filter: five smeared across a few minutes are dropped (COMM chapters)', () => {
  const events = [0, 1, 2, 3, 4].map((k) => ev({ n: 'Chapter ' + k, start: '2026-09-10T18:5' + k + ':00Z', end: '2026-09-10T18:5' + k + ':00Z' }));
  assert.equal(shape.calendar({ events }).length, 0);
});

test('the same five spread over different courses are kept', () => {
  const events = [0, 1, 2, 3, 4].map((k) => ev({ ou: String(k), n: 'Exam', start: '2026-12-10T05:00:00Z', end: '2026-12-10T05:00:00Z' }));
  assert.equal(shape.calendar({ events }).length, 5);
});

test('events attached to a quiz or dropbox are skipped; a timed exam is shaped', () => {
  const rows = shape.calendar({ events: [
    ev({ n: 'Unit 1', entity: 'Dropbox' }),
    ev({ n: 'Exam 2 Ch 4', start: '2026-10-29T16:45:00Z', end: '2026-10-29T17:40:00Z', where: 'Design 2 - 112' })
  ] });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.n, 'Exam 2 Ch 4  (scheduled)');
  assert.equal(r.d, '2026-10-29T16:45:00Z');
  assert.equal(r.end, '2026-10-29T17:40:00Z');
  assert.equal(r.t, 'q');
  assert.equal(r.exam, 1);
  assert.equal(r.timed, 1);
  assert.equal(r.src, 'cal');
  assert.equal(r.x, 1);
  assert.equal(r.s, undefined, 'a calendar row never invents a status');
});
