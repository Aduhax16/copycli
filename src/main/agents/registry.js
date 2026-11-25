import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { ClaudeDriver } from './claude.js';
import { CodexDriver } from './codex.js';
import { AntigravityDriver } from './antigravity.js';
import { AcpDriver } from './acp.js';
import { agentEnv, which } from '../env.js';
import { probe } from './probe.js';

// Newest file matching a path with one or more "*" directory segments.
function newest(pattern) {
  let dirs = ['/'];
  for (const seg of pattern.split('/').filter(Boolean)) {
    dirs = dirs.flatMap((d) => {
      if (seg !== '*') return [path.join(d, seg)];
      try { return fs.readdirSync(d).map((n) => path.join(d, n)); } catch { return []; }
    });
  }
  return dirs.filter((f) => fs.existsSync(f)).map((f) => [f, fs.statSync(f).mtimeMs]).sort((a, b) => b[1] - a[1])[0]?.[0];
}
const acp = (id, name, color, bins, args, extra = {}) => ({ id, name, color, bins, args, kind: 'acp', ...extra });

export const AGENTS = [
  { id: 'claude', name: 'Claude', color: '#d97757', kind: 'claude', bins: ['claude'], install: 'curl -fsSL https://claude.ai/install.sh | bash', login: ['auth', 'login'], statusArgs: ['auth', 'status', '--json'],
    fallback: () => newest(path.join(homedir(), 'Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude')) },
  { id: 'codex', name: 'Codex', color: '#3f8f78', kind: 'codex', bins: ['codex'], install: 'npm install -g @openai/codex', login: ['login'], statusArgs: ['login', 'status'],
    fallback: () => ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', '/Applications/Codex.app/Contents/Resources/codex'].find((f) => fs.existsSync(f)) },
  { id: 'antigravity', name: 'Antigravity', color: '#4a7fd6', aliases: ['agy'], kind: 'antigravity', bins: ['agy'], install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', login: [] },
  acp('gemini', 'Gemini CLI', '#7a6fd0', ['gemini'], ['--acp'], { install: 'npm install -g @google/gemini-cli', login: [] }),
  acp('copilot', 'GitHub Copilot', '#8a6fb0', ['copilot'], ['--acp'], { install: 'npm install -g @github/copilot', login: ['login'] }),
  acp('cursor', 'Cursor', '#7d8590', ['cursor-agent'], ['acp'], { login: ['login'], site: 'https://cursor.com/cli' }),
  acp('opencode', 'OpenCode', '#b0894f', ['opencode'], ['acp'], { install: 'npm install -g opencode-ai', login: ['auth', 'login'] }),
  acp('goose', 'Goose', '#5d9aa8', ['goose'], ['acp'], { login: ['configure'], site: 'https://block.github.io/goose' }),
  acp('qwen', 'Qwen Code', '#6f7bd9', ['qwen'], ['--acp'], { install: 'npm install -g @qwen-code/qwen-code', login: [] }),
  acp('kimi', 'Kimi Code', '#5b86c9', ['kimi'], ['acp'], { install: 'npm install -g @moonshot-ai/kimi-code', login: [] }),
  acp('grok', 'Grok Build', '#8b8f96', ['grok'], ['agent', 'stdio'], { install: 'npm install -g @xai-official/grok', login: [] }),
  acp('cline', 'Cline', '#b5755c', ['cline'], ['--acp'], { install: 'npm install -g cline', login: ['auth'] }),
  acp('auggie', 'Auggie', '#5fa36a', ['auggie'], ['--acp'], { install: 'npm install -g @augmentcode/auggie', login: ['login'] }),
  acp('kilo', 'Kilo', '#b79b3e', ['kilo'], ['acp'], { install: 'npm install -g @kilocode/cli', login: ['auth', 'login'] }),
  acp('qoder', 'Qoder', '#4f9f93', ['qodercli'], ['--acp'], { install: 'npm install -g @qoder-ai/qodercli', login: [] }),
  acp('kiro', 'Kiro', '#9a6cc2', ['kiro-cli'], ['acp', '--agent-engine=v3'], { login: ['login'], site: 'https://kiro.dev/cli' }),
  acp('devin', 'Devin', '#4b90b5', ['devin'], ['acp'], { login: [], site: 'https://devin.ai' }),
  acp('vibe', 'Mistral Vibe', '#cf7a45', ['vibe-acp'], [], { site: 'https://mistral.ai' }),
  acp('junie', 'Junie', '#5c9c55', ['junie'], ['--acp=true'], { site: 'https://www.jetbrains.com/junie' }),
  acp('amp', 'Amp', '#c56a5a', ['amp-acp'], [], { site: 'https://ampcode.com' }),
];

export function allAgents(custom = []) {
  return [...AGENTS, ...custom.map((c) => ({ id: c.id, name: c.name, color: c.color || '#888d94', bins: [c.command], args: c.args || [], kind: 'acp', custom: true }))];
}

const run = (cmd, args, env) => new Promise((r) => execFile(cmd, args, { env, timeout: 10000 }, (e, out, err) => r({ ok: !e, text: `${out}${err}` })));

export async function detect(def) {
  const env = await agentEnv();
  let p = null;
  for (const b of def.bins) { p = path.isAbsolute(b) ? (fs.existsSync(b) ? b : null) : which(b, env); if (p) break; }
  p ||= def.fallback?.() || null;
  if (!p) return { installed: false };
  let signedIn = null;
  if (def.statusArgs) {
    const s = await run(p, def.statusArgs, env);
    signedIn = def.id === 'claude' ? /"loggedIn":\s*true/.test(s.text) : s.ok && !/not logged in/i.test(s.text);
  }
  return { installed: true, path: p, signedIn };
}

export async function probeAgent(def, info, version) { return probe(def, info.path, await agentEnv(), version); }

export async function makeDriver(def, info, version) {
  const o = { path: info.path, args: def.args, env: await agentEnv(), version };
  return new ({ claude: ClaudeDriver, codex: CodexDriver, antigravity: AntigravityDriver, acp: AcpDriver }[def.kind])(o);
}
