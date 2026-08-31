#!/usr/bin/env node
/* Encrypt private/data.json and publish it as a secret gist.
 *
 * The gist holds ciphertext only. The key never leaves this machine except in
 * the URL fragment printed at the end, and browsers never send fragments to
 * servers — so GitHub stores something it cannot read.
 *
 *   node src/publish-sync.js            create or update the gist
 *   node src/publish-sync.js --rotate   throw away the old key and make a new one
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// Prefer the merged file build.py writes: it carries ALEKS and anything else
// D2L cannot see. Fall back to the raw scrape if a build hasn't run yet.
const MERGED = path.join(ROOT, 'private', 'data-merged.json');
const RAW = path.join(ROOT, 'private', 'data.json');
const DATA = fs.existsSync(MERGED) ? MERGED : RAW;
const STATE = path.join(ROOT, 'private', 'sync-state.json');
const PAYLOAD = path.join(ROOT, 'private', 'owl-hours-data.json');
const GIST_FILE = 'owl-hours-data.json';

function die(msg) { console.error('publish-sync: ' + msg); process.exit(1); }

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8' }).trim();
  } catch (e) {
    const out = (e.stderr || e.stdout || e.message || '').toString().trim();
    if (/not found|ENOENT/i.test(out)) {
      die('the GitHub CLI is not installed.\n  brew install gh && gh auth login');
    }
    die('gh failed: ' + out.split('\n')[0]);
  }
}

if (!fs.existsSync(DATA)) die('no data found — run a D2L scrape and then build.py first.');
const plaintext = fs.readFileSync(DATA);
const parsed = JSON.parse(plaintext);
if (!parsed.courses || !parsed.courses.length) die('private/data.json has no courses; refusing to publish.');

let state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
if (process.argv.includes('--rotate')) delete state.key;

// 256-bit key, reused across updates so the URL you saved keeps working
const key = state.key ? Buffer.from(state.key, 'base64') : crypto.randomBytes(32);
const iv = crypto.randomBytes(12);

const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag();

// WebCrypto expects the auth tag appended to the ciphertext
const envelope = {
  v: 1,
  alg: 'AES-GCM',
  iv: iv.toString('base64'),
  ct: Buffer.concat([ct, tag]).toString('base64')
};
fs.writeFileSync(PAYLOAD, JSON.stringify(envelope));

const nItems = parsed.courses.reduce((a, c) => a + (c.items || []).length, 0);

let gistId = state.gistId;
if (gistId) {
  gh(['gist', 'edit', gistId, '-f', GIST_FILE, PAYLOAD]);
} else {
  const url = gh(['gist', 'create', PAYLOAD, '-d', 'Owl Hours (encrypted)', '-f', GIST_FILE]);
  gistId = url.trim().split('/').pop();
}

const user = gh(['api', 'user', '-q', '.login']);
const raw = `https://gist.githubusercontent.com/${user}/${gistId}/raw/${GIST_FILE}`;
const syncUrl = `${raw}#k=${key.toString('base64')}`;

state = { gistId, key: key.toString('base64'), user };
fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
fs.chmodSync(STATE, 0o600);

console.log(`published ${parsed.courses.length} classes, ${nItems} items (encrypted)`);
console.log('\nPaste this into "Sync across your devices" on each device:\n');
console.log('  ' + syncUrl + '\n');
console.log('Anyone without the #k= part sees only ciphertext.');
console.log('The key is saved in private/sync-state.json — that file is gitignored; keep it.');
