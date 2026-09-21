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
const { autoUpdater } = require('electron-updater');

let wired = false;
let latest = null;

/** @param {(channel:string, payload:any)=>void} send */
function init(send) {
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Unsigned/ad-hoc builds: let it try rather than refusing up front.
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('update-available', (info) => {
    latest = info && info.version ? info.version : null;
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
  try {
    const r = await autoUpdater.checkForUpdates();
    const v = r && r.updateInfo ? r.updateInfo.version : null;
    return { ok: true, version: v };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function download() {
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** Replaces the running app and relaunches it. */
function install() {
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
}

module.exports = { init, check, download, install };
