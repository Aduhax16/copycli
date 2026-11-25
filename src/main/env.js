// Apps opened from Finder get a bare PATH, so ask the login shell for the real one.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let cached;

function shellPath() {
  if (process.platform === 'win32') return Promise.resolve('');
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-ilc', 'printf "__RD__%s__RD__" "$PATH"'], { timeout: 6000 }, (_e, out) => {
      resolve(/__RD__(.*?)__RD__/s.exec(out || '')?.[1] || '');
    });
  });
}

// Strip variables that make a child think it runs inside another agent's session.
export function cleanEnv(env) {
  const out = { ...env };
  const nested = 'CLAUDECODE' in out;
  for (const k of Object.keys(out)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_AGENT_SDK_')) delete out[k];
    else if (nested && (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_'))) delete out[k];
    else if (k.startsWith('ELECTRON_')) delete out[k];
  }
  return out;
}

export async function agentEnv() {
  if (cached) return { ...cached };
  const h = homedir();
  const extra = [path.join(h, '.local/bin'), path.join(h, '.npm-global/bin'), path.join(h, '.bun/bin'), path.join(h, '.opencode/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const parts = [...(await shellPath()).split(path.delimiter), ...(process.env.PATH || '').split(path.delimiter), ...(process.platform === 'win32' ? [] : extra)];
  cached = cleanEnv(process.env);
  cached.PATH = [...new Set(parts.filter(Boolean))].join(path.delimiter);
  return { ...cached };
}
export function forgetEnv() { cached = undefined; }

export function which(cmd, env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of env.PATH.split(path.delimiter)) for (const x of exts) {
    const p = path.join(dir, cmd + x);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}
