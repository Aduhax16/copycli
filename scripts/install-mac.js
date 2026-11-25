// Copies the packaged app to /Applications. Chats and settings live elsewhere and are kept.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const src = [`dist/mac-${process.arch}/CopyCLI.app`, 'dist/mac/CopyCLI.app'].find((p) => fs.existsSync(p));
const dst = '/Applications/CopyCLI.app';
if (!src) throw new Error('Run "npm run pack" first');
const idOf = (a) => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', `${a}/Contents/Info.plist`], { encoding: 'utf8' }).trim();
if (fs.existsSync(dst) && idOf(dst) !== idOf(src)) throw new Error(`${dst} is a different app; not replacing it`);
const running = () => { try { execFileSync('pgrep', ['-f', `${dst}/Contents/MacOS/`]); return true; } catch { return false; } };
// --wait installs as soon as the app is closed, then opens it again.
const wait = process.argv.includes('--wait');
if (running() && !wait) { console.error('Quit CopyCLI first, then run this again (or pass --wait).'); process.exit(1); }
while (running()) await new Promise((r) => setTimeout(r, 1000));
fs.rmSync(dst, { recursive: true, force: true });
execFileSync('ditto', [src, dst]);
fs.rmSync('dist', { recursive: true, force: true }); // a second copy confuses macOS
if (wait) execFileSync('open', [dst]);
console.log(`Installed ${dst}`);
