const test = require('node:test');
const assert = require('node:assert/strict');
const shape = require('../electron/shape');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const one = (i) => shape.aleks({ courses: [{ ou: '9', items: [i] }] }, NOW)[0].items[0];

test('ALEKS: "Closed" past the deadline with no progress is missed, not done', () => {
  assert.equal(one({ n: 'HW 5', type: 'Homework', status: 'Closed', pct: 0, d: '2026-11-01T03:59:00Z' }).s, 'Not Submitted');
});

test('ALEKS: homework is done at 100% or when every topic is complete', () => {
  assert.equal(one({ n: 'HW 6', type: 'Homework', pct: 100 }).s, 'Completed');
  assert.equal(one({ n: 'HW 7', type: 'Homework', pct: 80, details: '12 out of 12 topics completed' }).s, 'Completed');
  assert.equal(one({ n: 'HW 8', type: 'Homework', pct: 80, details: '10 out of 12 topics completed', d: '2026-12-01T03:59:00Z' }).s, 'Not Submitted');
});

test('ALEKS: past the deadline, partial progress was submitted', () => {
  const r = one({ n: 'HW 9', type: 'Homework', pct: 70, d: '2026-11-01T03:59:00Z' });
  assert.equal(r.s, 'Submitted');
  assert.equal(r.e, 70);
  assert.equal(r.p, 100);
});

test('ALEKS: a test with any score was taken', () => {
  const r = one({ n: 'Test 2', type: 'Test', pct: 64, d: '2026-12-01T03:59:00Z' });
  assert.equal(r.s, 'Completed');
  assert.equal(r.t, 'q');
  assert.equal(one({ n: 'Knowledge Check', type: '', pct: 30 }).s, 'Completed');
  assert.equal(one({ n: 'Quiz 1', type: 'Quiz', pct: null, status: '' }).s, 'Not Submitted');
});

test('ALEKS rows are tagged and survive a D2L refresh', () => {
  const r = one({ n: 'HW 1', type: 'Homework', pct: 100 });
  assert.equal(r.n, 'HW 1  (ALEKS)');
  assert.equal(r.src, 'aleks');
  assert.equal(r.x, 1);
});

const gs = (status) => shape.gradescope({ courses: [{ code: 'CSE1321L', name: 'Lab', href: '/courses/1', items: [{ n: 'Lab 1', status, u: null }] }] })[0].items[0];

test('Gradescope: a score means graded, with the points kept', () => {
  const r = gs('105.0 / 100.0');
  assert.equal(r.s, 'Graded');
  assert.equal(r.e, 105);
  assert.equal(r.p, 100);
});

test('Gradescope: no submission, submitted, and blank status', () => {
  assert.equal(gs('No Submission').s, 'Not Submitted');
  assert.equal(gs('Submitted').s, 'Submitted');
  assert.equal(gs('').s, 'Submitted');
});

test('Gradescope rows link to the assignment, or the course when there is none', () => {
  const r = gs('Submitted');
  assert.equal(r.u, 'https://www.gradescope.com/courses/1');
  assert.equal(r.n, 'Lab 1  (Gradescope)');
  assert.equal(r.src, 'gs');
  const withLink = shape.gradescope({ courses: [{ code: 'X', name: 'Y', href: '/courses/1', items: [{ n: 'A', status: '', u: '/courses/1/assignments/2' }] }] })[0].items[0];
  assert.equal(withLink.u, 'https://www.gradescope.com/courses/1/assignments/2');
});
