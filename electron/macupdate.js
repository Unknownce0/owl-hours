/* Self-update on the Mac, without Squirrel.
 *
 * electron-updater hands a Mac install to Squirrel.Mac, which refuses any build
 * not signed by the same registered Apple developer as the running one. These
 * builds are ad-hoc signed, so Squirrel always said no. This does the same job
 * by hand:
 *
 *   1. download the release zip and check it against the sha512 in the feed
 *   2. unpack it with ditto (keeps the bundle's symlinks and metadata intact)
 *      and check the unpacked app's signature is whole
 *   3. once the app has quit, a detached helper swaps the new bundle in over
 *      the old one — keeping the old one until the new one is in place — and
 *      reopens it
 *
 * Only Node built-ins, so every step can be tested outside Electron.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(path.basename(cmd) + ' failed: ' + String(stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/* GitHub answers a release download with a redirect to its storage host. */
function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'OwlHours-updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= 5) return reject(new Error('too many redirects'));
        return resolve(get(new URL(res.headers.location, url).toString(), hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('download failed, status ' + res.statusCode));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('download timed out')));
  });
}

async function download(url, dest, expectSha512, onProgress = () => {}) {
  const res = await get(url);
  const total = +res.headers['content-length'] || 0;
  const hash = crypto.createHash('sha512');
  let got = 0, lastPct = -1;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.on('data', (chunk) => {
      hash.update(chunk);
      got += chunk.length;
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  const sha = hash.digest('base64');
  if (expectSha512 && sha !== expectSha512) {
    throw new Error('the download did not match the release checksum');
  }
}

/* Download, verify and unpack. Resolves with the path of the new .app. */
async function prepare({ url, sha512, workDir, onProgress }) {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const zip = path.join(workDir, 'update.zip');
  await download(url, zip, sha512, onProgress);

  const unpacked = path.join(workDir, 'unpacked');
  await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
  fs.rmSync(zip, { force: true });

  const name = fs.readdirSync(unpacked).find((f) => f.endsWith('.app'));
  if (!name) throw new Error('the update did not contain an app');
  const app = path.join(unpacked, name);

  // Cheap insurance before the swap: a damaged bundle fails this.
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]).catch(() => {});
  return app;
}

/* .../Owl Hours.app/Contents/MacOS/Owl Hours -> .../Owl Hours.app */
function bundlePath(execPath) {
  const p = path.resolve(execPath, '..', '..', '..');
  return p.endsWith('.app') ? p : null;
}

/* Can this copy of the app be replaced in place? */
function canReplace(bundle) {
  if (!bundle) return { ok: false, why: 'couldn’t find where the app is installed' };
  if (bundle.startsWith('/Volumes/')) {
    return { ok: false, why: 'the app is running from the disk image — drag it into Applications first' };
  }
  if (bundle.includes('/AppTranslocation/')) {
    return { ok: false, why: 'macOS is running the app from a temporary copy — move it into Applications and reopen it' };
  }
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch (e) {
    return { ok: false, why: 'you don’t have permission to replace the app where it is installed' };
  }
  return { ok: true };
}

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

/* The helper that runs after the app has quit. The old bundle is only thrown
   away once the new one is in place; if the move fails, the old one goes back. */
function swapScript({ pid, oldApp, newApp, workDir, reopen = true }) {
  return [
    '#!/bin/bash',
    'PID=' + q(pid),
    'OLD=' + q(oldApp),
    'NEW=' + q(newApp),
    'WORK=' + q(workDir),
    'BACKUP="$OLD.previous"',
    // wait up to 30s for the running app to exit
    'for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done',
    'rm -rf "$BACKUP"',
    'if mv "$OLD" "$BACKUP"; then',
    '  if mv "$NEW" "$OLD" || /usr/bin/ditto "$NEW" "$OLD"; then',
    '    rm -rf "$BACKUP"',
    '  else',
    '    rm -rf "$OLD"; mv "$BACKUP" "$OLD"',
    '  fi',
    'fi',
    '/usr/bin/xattr -dr com.apple.quarantine "$OLD" 2>/dev/null',
    reopen ? '/usr/bin/open "$OLD"' : ':',
    'rm -rf "$WORK"',
    ''
  ].join('\n');
}

function launchSwap(opts) {
  const script = path.join(path.dirname(opts.workDir), 'owl-hours-swap-' + process.pid + '.sh');
  fs.writeFileSync(script, swapScript(opts) + 'rm -f ' + q(script) + '\n', { mode: 0o755 });
  spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
  return script;
}

module.exports = { prepare, bundlePath, canReplace, swapScript, launchSwap, download };
