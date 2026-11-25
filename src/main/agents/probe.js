// Asks each installed agent which models it offers and how much of the plan is used. Runs no model.
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { spawnJsonl, spawnRpc } from './proc.js';

const limit = (p, ms) => { let t; return Promise.race([p, new Promise((_r, no) => { t = setTimeout(() => no(new Error('timeout')), ms); })]).finally(() => clearTimeout(t)); };

export function codexUsage(r) {
  const w = (x) => (x ? { usedPercent: Math.round(x.usedPercent), resetsAt: x.resetsAt, minutes: x.windowDurationMins } : null);
  return r ? [w(r.primary), w(r.secondary)].filter(Boolean) : [];
}
// `agy models` lists each model once per thinking level; show the model once and its levels as effort.
export function parseAgyModels(text) {
  const out = new Map();
  for (const l of text.split('\n')) {
    const m = /^\s*([a-z][a-z0-9]*(?:[-.][a-z0-9.]+)+)\s+(\S.*)$/.exec(l);
    if (!m) continue;
    const [, base, level] = /^(.*?)(?:-(low|medium|high|xhigh))?$/.exec(m[1]);
    const x = out.get(base) || { id: base, name: m[2].replace(/\s*\((Low|Medium|High|XHigh)\)\s*$/, '').trim(), efforts: [] };
    if (level) x.efforts.push(level);
    out.set(base, x);
  }
  const rank = ['low', 'medium', 'high', 'xhigh'];
  return [...out.values()].map((x) => ({ ...x, efforts: rank.filter((r) => x.efforts.includes(r)) }));
}

async function codex(path, env, version) {
  const rpc = spawnRpc(path, ['app-server'], { cwd: tmpdir(), env, onRequest: async () => { throw new Error('no'); }, onNotify() {} });
  try {
    return await limit((async () => {
      await rpc.request('initialize', { clientInfo: { name: 'copycli', title: 'CopyCLI', version }, capabilities: null });
      rpc.notify('initialized');
      const [m, c, l] = await Promise.all([rpc.request('model/list', {}), rpc.request('config/read', {}).catch(() => null), rpc.request('account/rateLimits/read').catch(() => null)]);
      return {
        models: m.data.filter((x) => !x.hidden).map((x) => ({ id: x.model, name: x.displayName, desc: x.description, efforts: (x.supportedReasoningEfforts || []).map((e) => e.reasoningEffort) })),
        defaultModel: c?.config?.model || m.data.find((x) => x.isDefault)?.model || null,
        usage: codexUsage(l?.rateLimits),
      };
    })(), 15000);
  } finally { rpc.kill(); }
}
async function claude(path, env) {
  let done;
  const got = new Promise((r) => { done = r; });
  const p = spawnJsonl(path, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], {
    cwd: tmpdir(), env, onJson: (m) => { if (m.type === 'control_response') done(m.response?.response?.models || []); }, onExit: () => done([]),
  });
  p.send({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } });
  try {
    const ms = await limit(got, 15000);
    const def = ms.find((m) => m.value === 'default')?.resolvedModel;
    return { models: ms.filter((m) => m.value !== 'default').map((m) => ({ id: m.value, name: m.displayName, desc: m.description, efforts: m.supportedEffortLevels || [] })), defaultModel: ms.find((m) => m.value !== 'default' && m.resolvedModel === def)?.value || def || null };
  } finally { p.kill(); }
}
const agy = (path, env) => new Promise((r) => execFile(path, ['models'], { env, timeout: 15000 }, (_e, out) => r({ models: parseAgyModels(out || '') })));

export async function probe(def, path, env, version) {
  const f = { codex, claude, agy }[def.probe || def.kind];
  return f ? f(path, env, version) : {};
}
