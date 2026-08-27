/* Ad-hoc sign the packaged .app.
 *
 * Without an Apple Developer certificate electron-builder leaves the bundle
 * carrying the Electron binary's own linker signature, which no longer matches
 * once the bundle is renamed and repacked. macOS reports that mismatch as
 * "is damaged and can't be opened" — not as an unidentified developer — and
 * right-click → Open will not get past it.
 *
 * Signing ad-hoc makes the signature valid for the actual bundle. Users still
 * have to clear the quarantine flag, but they no longer see "damaged".
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename + '.app';
  const appPath = path.join(context.appOutDir, appName);
  if (!fs.existsSync(appPath)) {
    console.log('  • adhoc-sign: no app bundle at ' + appPath);
    return;
  }

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
    const out = execFileSync('codesign', ['-dv', appPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    console.log('  • adhoc-signed and verified  ' + appName);
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim().split('\n')[0];
    throw new Error('ad-hoc signing failed for ' + appName + ': ' + msg);
  }
};
