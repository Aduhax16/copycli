// Copies the packaged app to /Applications. Chats and settings live elsewhere and are kept.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const src = [`dist/mac-${process.arch}/CopyCLI.app`, 'dist/mac/CopyCLI.app'].find((p) => fs.existsSync(p));
const dst = '/Applications/CopyCLI.app';
if (!src) throw new Error('Run "npm run pack" first');
const idOf = (a) => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', `${a}/Contents/Info.plist`], { encoding: 'utf8' }).trim();
if (fs.existsSync(dst) && idOf(dst) !== idOf(src)) throw new Error(`${dst} is a different app; not replacing it`);
try { execFileSync('pgrep', ['-f', `${dst}/Contents/MacOS/`]); console.error('Quit CopyCLI first, then run this again.'); process.exit(1); } catch {}
fs.rmSync(dst, { recursive: true, force: true });
execFileSync('ditto', [src, dst]);
console.log(`Installed ${dst}`);
