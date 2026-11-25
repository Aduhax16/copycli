// Any agent that speaks the Agent Client Protocol (Antigravity, Copilot, OpenCode, Cursor, Goose, ...).
import { spawnRpc } from './proc.js';
import { isLimitError } from '../limits.js';
import { TEAM_TOOLS } from '../team-tools.js';
import { BROWSER_TOOLS } from '../browser-tools.js';

// CopyCLI's own tools ask for what they need themselves, so agents need not ask again.
// Exact names only, and never for a command or edit: a title can carry text the model wrote.
const OWN = new Set([...TEAM_TOOLS, ...BROWSER_TOOLS].flatMap(({ name: n }) => [`mcp_copycli_${n}`, `mcp__copycli__${n}`, `copycli_${n}`, `copycli__${n}`, `copycli/${n}`, `copycli.${n}`, `copycli:${n}`, `copycli - ${n}`, `${n} (copycli MCP Server)`]));
export function isOwnTool(c = {}) {
  if (c.kind && c.kind !== 'other') return false;
  return OWN.has(c.name) || OWN.has(String(c.title || '').replace(/^Run /, ''));
}
const MODE = { plan: ['plan'], ask: ['default', 'ask'], edit: ['accept-edits', 'acceptEdits', 'auto-edit', 'auto_edit'], full: ['default', 'ask'] };

const textOf = (c) => (Array.isArray(c) ? c : []).map((x) => (x.type === 'content' ? x.content?.text || '' : x.type === 'diff' ? `${x.path}` : '')).filter(Boolean).join('\n');
const ERR = { completed: 'done', failed: 'error' };

export class AcpDriver {
  constructor(opts) { this.o = opts; this.rpc = null; this.session = null; this.turn = null; this.files = new Map(); }

  async start(cwd, mcp) {
    if (this.rpc?.alive) return;
    this.session = null;
    const rpc = spawnRpc(this.o.path, this.o.args || [], {
      cwd, env: { ...this.o.env, COPYCLI_MCP_URL: mcp.url, COPYCLI_MCP_TOKEN: mcp.token },
      onRequest: (m, p) => this.request(m, p),
      onNotify: (m, p) => m === 'session/update' && this.update(p),
      onExit: () => { if (this.rpc === rpc) this.rpc = null; },
    });
    this.rpc = rpc;
    const timer = setTimeout(() => rpc.kill(), 60000);
    try { this.caps = (await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'copycli', title: 'CopyCLI', version: this.o.version } })).agentCapabilities || {}; }
    finally { clearTimeout(timer); }
  }

  servers(mcp) {
    if (this.caps.mcpCapabilities?.http) return [{ type: 'http', name: 'copycli', url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }];
    return [{ name: 'copycli', command: mcp.bridge.command, args: mcp.bridge.args, env: Object.entries({ ...mcp.bridge.env, COPYCLI_MCP_URL: mcp.url, COPYCLI_MCP_TOKEN: mcp.token }).map(([name, value]) => ({ name, value })) }];
  }

  async request(method, p) {
    if (method !== 'session/request_permission') throw Object.assign(new Error('Not supported'), { code: -32601 });
    const t = this.turn, opts = p.options || [], pick = (...k) => opts.find((o) => k.includes(o.kind));
    if (!t) return { outcome: { outcome: 'cancelled' } };
    const ours = isOwnTool(p.toolCall);
    let r;
    if (t.mode === 'plan' && !ours) r = 'deny';
    else if (t.mode === 'full' || ours || (t.mode === 'edit' && p.toolCall?.kind === 'edit')) r = 'allow';
    else r = await t.onApproval({ title: p.toolCall?.title || 'Use a tool', detail: p.toolCall?.rawInput ? JSON.stringify(p.toolCall.rawInput).slice(0, 2000) : '', toolId: p.toolCall?.toolCallId, canAlways: !!pick('allow_always') });
    if (t.signal.aborted) return { outcome: { outcome: 'cancelled' } };
    const o = r === 'deny' ? pick('reject_once', 'reject_always') : r === 'always' ? pick('allow_always') || pick('allow_once') : pick('allow_once');
    return { outcome: o ? { outcome: 'selected', optionId: o.optionId } : { outcome: 'cancelled' } };
  }

  update({ sessionId, update: u = {} }) {
    const t = this.turn;
    if (!t || t.loading || sessionId !== this.session) return;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
      if (t.last !== 'text') onBreak(t);
      t.last = 'text';
      t.onEvent({ type: 'text', delta: u.content.text });
    } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      t.last = 'tool';
      const loc = (u.locations || []).map((l) => l.path);
      t.onEvent({ type: 'tool', id: u.toolCallId, ...(u.title || u.sessionUpdate === 'tool_call' ? { name: u.title || u.kind || 'Tool' } : {}), ...(loc.length ? { detail: loc.join('\n') } : {}), status: ERR[u.status] || 'running', ...(u.content ? { output: textOf(u.content).slice(0, 4000) } : {}) });
      const diffs = (u.content || []).filter((c) => c.type === 'diff').map((c) => c.path);
      const kind = u.kind || t.kinds.get(u.toolCallId);
      if (u.kind) t.kinds.set(u.toolCallId, u.kind);
      const touched = diffs.length ? diffs : kind === 'edit' ? loc : [];
      if (touched.length && u.status === 'completed') t.onEvent({ type: 'files', paths: touched });
    }
  }

  // Agents that let the client choose a model list it with the session.
  models(r) {
    this.choices(r);
    const o = (r?.configOptions || []).find((x) => x.category === 'model' && x.type === 'select');
    if (o) { this.modelOpt = o.id; return (o.options || []).flatMap((x) => x.options || [x]).map((x) => ({ id: x.value, name: x.name, desc: x.description, efforts: this.effortOpt?.values || [] })); }
    this.modelOpt = null;
    return (r?.models?.availableModels || []).map((x) => ({ id: x.modelId, name: x.name, desc: x.description, efforts: [] }));
  }
  // Other choices the agent offers with the session: how hard it thinks and what it may do alone.
  choices(r) {
    const by = (cat) => (r?.configOptions || []).find((x) => x.category === cat && x.type === 'select');
    const values = (o) => (o ? (o.options || []).flatMap((x) => x.options || [x]).map((x) => x.value) : []);
    const e = by('thought_level'), m = by('mode');
    this.effortOpt = e && { id: e.id, values: values(e) };
    this.modeOpt = m && { id: m.id, values: values(m), now: m.currentValue };
  }
  async setChoices(effort, mode) {
    const set = (id, value) => this.rpc.request('session/set_config_option', { sessionId: this.session, configId: id, value });
    if (effort && effort !== this.effort && this.effortOpt?.values.includes(effort)) { await set(this.effortOpt.id, effort); this.effort = effort; }
    const want = this.modeOpt && (MODE[mode] || []).find((v) => this.modeOpt.values.includes(v));
    if (want && want !== this.modeOpt.now) { await set(this.modeOpt.id, want); this.modeOpt.now = want; }
  }
  async setModel(model) {
    if (!model || model === this.model) return;
    if (this.modelOpt) await this.rpc.request('session/set_config_option', { sessionId: this.session, configId: this.modelOpt, value: model });
    else await this.rpc.request('session/set_model', { sessionId: this.session, modelId: model });
    this.model = model;
    this.effort = null; // a new model starts at its own level
  }

  async run({ prompt, cwd, mode, model, effort, sessionId, instructions, mcp, onEvent, onApproval, signal }) {
    this.turn = { onEvent, onApproval, mode, signal, kinds: new Map() };
    const stop = () => { if (this.session) this.rpc?.notify('session/cancel', { sessionId: this.session }); setTimeout(() => { if (this.turn?.signal === signal) this.dispose(); }, 4000).unref(); };
    signal.addEventListener('abort', stop);
    try {
      await this.start(cwd, mcp);
      let fresh = false;
      if (!this.session) {
        const base = { cwd, mcpServers: this.servers(mcp) };
        if (sessionId && this.caps.loadSession) {
          this.turn.loading = true;
          try { const r = await this.rpc.request('session/load', { sessionId, ...base }); this.session = sessionId; const ms = this.models(r); if (ms.length) onEvent({ type: 'models', models: ms }); } catch {}
          this.turn.loading = false;
        }
        if (!this.session) { const r = await this.rpc.request('session/new', base); this.session = r.sessionId; this.model = this.effort = null; const ms = this.models(r); if (ms.length) onEvent({ type: 'models', models: ms }); fresh = true; if (sessionId) onEvent({ type: 'session-lost' }); }
        onEvent({ type: 'session', id: this.session });
      }
      if (signal.aborted) return { status: 'cancelled', sessionId: this.session };
      await this.setModel(model).catch((e) => onEvent({ type: 'text', delta: `_Could not switch to ${model}: ${e.message}_\n\n` }));
      await this.setChoices(effort, mode).catch((e) => onEvent({ type: 'text', delta: `_Could not apply a setting: ${e.message}_\n\n` }));
      if (signal.aborted) return { status: 'cancelled', sessionId: this.session };
      const r = await this.rpc.request('session/prompt', { sessionId: this.session, prompt: [{ type: 'text', text: fresh || !sessionId ? `${instructions}\n\n${prompt}` : prompt }] });
      const u = r?.usage;
      if (u) onEvent({ type: 'usage', fresh: (u.inputTokens || 0) + (u.cachedWriteTokens || 0), cached: u.cachedReadTokens || 0, output: u.outputTokens || 0 });
      if (r?.stopReason === 'cancelled') return { status: 'cancelled', sessionId: this.session };
      return { status: r?.stopReason === 'refusal' ? 'error' : 'done', error: r?.stopReason === 'refusal' ? 'The agent declined this request.' : undefined, sessionId: this.session };
    } catch (e) {
      if (signal.aborted) return { status: 'cancelled', sessionId: this.session };
      const msg = [e.message, typeof e.data === 'string' ? e.data : e.data ? JSON.stringify(e.data) : ''].filter(Boolean).join(': ');
      return { status: isLimitError(msg) ? 'limit' : 'error', error: msg, sessionId: this.session || sessionId };
    } finally { signal.removeEventListener('abort', stop); this.turn = null; }
  }
  dispose() { this.rpc?.kill(); this.rpc = null; this.session = null; }
}
function onBreak(t) { t.onEvent({ type: 'break' }); }
