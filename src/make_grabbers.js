/* Generate the three grabber flavours from the one copy inside index.html:
     grabber-bookmarklet.txt   javascript: URL for a bookmarks-bar button
     grabber.js                bare source, for pasting into a console
     grabber-ios-shortcut.js   Shortcuts variant, returns via completion()
*/
const fs = require('fs');

const src = fs.readFileSync('index.html', 'utf8');
const m = src.match(/var SCRAPER = ([\s\S]*?);\n\nfunction renderSync/);
if (!m) { console.error('SCRAPER not found in index.html'); process.exit(1); }

const bookmarklet = eval(m[1]);
const code = bookmarklet.replace(/^javascript:/, '');
try { new Function(code); } catch (e) { console.error('SYNTAX ERROR (base):', e.message); process.exit(1); }

fs.writeFileSync('grabber-bookmarklet.txt', bookmarklet + '\n');
fs.writeFileSync('grabber.js', code + '\n');

// --- Shortcuts variant -------------------------------------------------
const startMark = "var W=document.createElement('div');";
const endMark = 'document.body.appendChild(W);sel();';
const a = code.indexOf(startMark);
const b = code.indexOf(endMark);
if (a < 0 || b < 0) { console.error('overlay markers not found'); process.exit(1); }

let ios = code.slice(0, a) + 'completion(out);' + code.slice(b + endMark.length);

// every exit path has to call completion() or the Shortcut hangs forever
const swaps = [
  ["alert('Owl Hours: run this while you are on your D2L page.');return",
   "completion('ERROR: open your D2L page first');return"],
  ["alert('Owl Hours: no courses found. Are you signed in?');return",
   "completion('ERROR: no courses found, sign in to D2L first');return"],
  [".catch(function(e){alert('Owl Hours: '+e)})",
   ".catch(function(e){completion('ERROR: '+e)})"]
];
for (const [from, to] of swaps) {
  if (!ios.includes(from)) { console.error('missing exit path:', from.slice(0, 40)); process.exit(1); }
  ios = ios.split(from).join(to);
}

try { new Function('completion', ios); } catch (e) { console.error('SYNTAX ERROR (ios):', e.message); process.exit(1); }
fs.writeFileSync('grabber-ios-shortcut.js', ios + '\n');

console.log('  grabber-bookmarklet.txt  %d chars', bookmarklet.length);
console.log('  grabber.js               %d chars', code.length);
console.log('  grabber-ios-shortcut.js  %d chars  completion() calls: %d  alerts left: %d',
  ios.length, (ios.match(/completion\(/g) || []).length, (ios.match(/alert\(/g) || []).length);
