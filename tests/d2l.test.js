require('./electron-stub');
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyStop } = require('../electron/d2l');

const MS = 'https://login.microsoftonline.com/common/login';

test('classifyStop names the Microsoft page the quiet sign-in stopped on', () => {
  assert.equal(classifyStop('https://kennesaw.view.usg.edu/d2l/home', '', ''), 'd2l');
  assert.equal(classifyStop(MS, 'ConvergedProofUpRedirect', ''), 'setup');
  assert.equal(classifyStop(MS, '', 'More information required'), 'setup');
  assert.equal(classifyStop(MS, 'ConvergedTFA', ''), 'approve');
  assert.equal(classifyStop(MS, '', 'Approve sign in request'), 'approve');
  assert.equal(classifyStop(MS, 'KmsiInterrupt', ''), 'stay');
  assert.equal(classifyStop(MS, '', 'Pick an account'), 'pick');
  assert.equal(classifyStop(MS, '', 'Enter password'), 'password');
  assert.equal(classifyStop(MS, 'ConvergedChangePassword', ''), 'password-expired');
  assert.equal(classifyStop(MS, '', 'Your password has expired'), 'password-expired');
  assert.equal(classifyStop(MS, 'ConvergedError', ''), 'error');
  assert.equal(classifyStop(MS, '', ''), 'microsoft');
  assert.equal(classifyStop('https://example.com/x', '', ''), 'other');
  assert.equal(classifyStop('not a url', '', ''), 'unknown');
});

test('a look-alike host is not Microsoft', () => {
  assert.equal(classifyStop('https://microsoftonline.com.evil.test/', '', 'Enter password'), 'other');
});
