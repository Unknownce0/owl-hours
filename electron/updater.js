/* One-click updates.
 *
 * Until now an update meant: notice the banner, open GitHub, work out which of
 * several files you need, download it, and install it by hand. Friends simply
 * did not bother, which is why some of them sat three versions behind and were
 * missing exams.
 *
 * electron-updater reads the release feed electron-builder publishes alongside
 * the installers, so the app can fetch and apply its own update. Two platform
 * facts shape everything here:
 *
 *   - Windows updates only work from an *installed* app. A portable .exe has
 *     nothing on disk to replace, so the target is now NSIS.
 *   - macOS updates go through Squirrel.Mac, which verifies the code signature
 *     of the downloaded build against the running one. These builds are
 *     ad-hoc signed (no Apple Developer ID), and Squirrel is expected to
 *     refuse that. So the Mac path is allowed to fail, and says so plainly
 *     rather than looking like it worked — the caller then falls back to
 *     downloading the disk image.
 *
 * autoDownload is off on purpose: nobody should be spending their data without
 * pressing something first.
 */
/* Loaded defensively. update-my-app.sh patches a personal build by copying
   the .js files into the existing bundle — it does not carry node_modules
   across, so requiring this at the top crashed that app on launch before the
   window even opened. A personal build never auto-updates anyway (it would
   overwrite its own baked-in coursework), so the right behaviour when the
   dependency is absent is to do nothing quietly, not to die. */
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch (e) {
  autoUpdater = null;
}
const missing = () => ({ ok: false, error: 'this build has no updater' });

/* On the Mac, electron-updater still reads the release feed, but the download
   and install are done by macupdate.js instead of Squirrel, which rejects
   ad-hoc signed builds. Windows keeps the standard path. */
const isMac = process.platform === 'darwin';
const fs = require('fs');
const os = require('os');
const path = require('path');
const macUpdate = require('./macupdate');

let wired = false;
let latest = null;
let latestInfo = null;
let sendFn = () => {};
let prepared = null;           // { app, workDir, version } once a Mac update is unpacked

/* owner/repo come from the feed file electron-builder writes into a release
   build. A personal build has none, which is also what keeps it from updating. */
function feedRepo() {
  try {
    const y = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const owner = (y.match(/^owner:\s*(\S+)/m) || [])[1];
    const repo = (y.match(/^repo:\s*(\S+)/m) || [])[1];
    return owner && repo ? { owner, repo } : null;
  } catch (e) { return null; }
}

function macFile(info) {
  const files = (info && info.files) || [];
  const arm = process.arch === 'arm64';
  return files.find((f) => /-mac\.zip$/.test(f.url) && (arm ? /arm64/.test(f.url) : !/arm64/.test(f.url)));
}

async function macDownload() {
  if (!latestInfo) {
    const r = await autoUpdater.checkForUpdates();
    latestInfo = r && r.updateInfo;
  }
  const info = latestInfo;
  const feed = feedRepo();
  const file = macFile(info);
  if (!info || !feed || !file) return { ok: false, error: 'couldn’t find the Mac download in this release' };

  // No point downloading something that can't be installed where the app is.
  const here = macUpdate.canReplace(macUpdate.bundlePath(process.execPath));
  if (!here.ok) {
    sendFn('owl:update', { state: 'error', message: here.why });
    return { ok: true };
  }

  const url = /^https?:/.test(file.url) ? file.url
    : 'https://github.com/' + feed.owner + '/' + feed.repo + '/releases/download/v' + info.version + '/' + encodeURIComponent(file.url);
  const workDir = path.join(os.tmpdir(), 'owl-hours-update-' + info.version);
  sendFn('owl:update', { state: 'downloading', percent: 0 });
  try {
    const app = await macUpdate.prepare({
      url, sha512: file.sha512, workDir,
      onProgress: (pct) => sendFn('owl:update', { state: 'downloading', percent: pct })
    });
    prepared = { app, workDir, version: info.version };
    sendFn('owl:update', { state: 'ready', version: info.version });
  } catch (e) {
    sendFn('owl:update', { state: 'error', message: String((e && e.message) || e) });
  }
  return { ok: true };
}

/** @param {(channel:string, payload:any)=>void} send */
function init(send) {
  if (!autoUpdater || wired) return;
  wired = true;
  sendFn = send;

  autoUpdater.autoDownload = false;
  // Never let Squirrel try an install on quit; on the Mac we install ourselves.
  autoUpdater.autoInstallOnAppQuit = !isMac;
  // Unsigned/ad-hoc builds: let it try rather than refusing up front.
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('update-available', (info) => {
    latest = info && info.version ? info.version : null;
    latestInfo = info || null;
    send('owl:update', { state: 'available', version: latest });
  });
  autoUpdater.on('update-not-available', () => {
    send('owl:update', { state: 'current' });
  });
  autoUpdater.on('download-progress', (p) => {
    send('owl:update', { state: 'downloading', percent: Math.round(p.percent || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    send('owl:update', { state: 'ready', version: (info && info.version) || latest });
  });
  autoUpdater.on('error', (err) => {
    const msg = String((err && err.message) || err);
    /* Squirrel.Mac rejecting an ad-hoc signature is the expected outcome on a
       Mac, not a mystery. Name it so the UI can offer the manual route
       instead of showing a stack trace nobody can act on. */
    const signature = process.platform === 'darwin' &&
      /code signature|not signed|SQRL|CodeSign|sha512/i.test(msg);
    send('owl:update', { state: 'error', message: msg, signature });
  });
}

async function check() {
  if (!autoUpdater) return missing();
  try {
    const r = await autoUpdater.checkForUpdates();
    const v = r && r.updateInfo ? r.updateInfo.version : null;
    return { ok: true, version: v };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function download() {
  if (!autoUpdater) return missing();
  if (isMac) {
    try { return await macDownload(); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** Replaces the running app and relaunches it. */
function install() {
  if (!autoUpdater) return missing();
  if (isMac) {
    if (!prepared) return { ok: false, error: 'nothing has been downloaded yet' };
    const bundle = macUpdate.bundlePath(process.execPath);
    const here = macUpdate.canReplace(bundle);
    if (!here.ok) return { ok: false, error: here.why };
    macUpdate.launchSwap({ pid: process.pid, oldApp: bundle, newApp: prepared.app, workDir: prepared.workDir });
    // The helper waits for this process to exit before it touches anything.
    setTimeout(() => require('electron').app.quit(), 300);
    return { ok: true };
  }
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
}

module.exports = { init, check, download, install };
