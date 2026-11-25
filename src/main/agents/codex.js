// Codex, driven through `codex app-server` (JSON-RPC over stdio).
import { spawnRpc } from './proc.js';
import { isLimitError } from '../limits.js';

const MODES = {
  plan: { approvalPolicy: 'never', sandbox: 'read-only', policy: { type: 'readOnly', networkAccess: false } },
  ask: { approvalPolicy: 'untrusted', sandbox: 'read-only', policy: { type: 'readOnly', networkAccess: false } },
  edit: { approvalPolicy: 'on-request', sandbox: 'workspace-write', policy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
  full: { approvalPolicy: 'never', sandbox: 'danger-full-access', policy: { type: 'dangerFullAccess' } },
};
const cap = (s, n = 4000) => (s && s.length > n ? s.slice(0, n) + '\n…' : s || '');

export function codexTool(i) {
  const st = { inProgress: 'running', completed: 'done', failed: 'error', declined: 'error' }[i.status] || 'done';
  switch (i.type) {
    case 'commandExecution': return { id: i.id, name: 'Shell', detail: i.command, status: st === 'done' && i.exitCode ? 'error' : st, output: cap(i.aggregatedOutput) };
    case 'fileChange': return { id: i.id, name: 'Edit', detail: (i.changes || []).map((c) => c.path).join('\n'), status: st, output: cap((i.changes || []).map((c) => c.diff || '').join('\n')) };
    case 'mcpToolCall': return { id: i.id, name: `${i.server} · ${i.tool}`, detail: cap(JSON.stringify(i.arguments || {}), 300), status: st, output: cap((i.result?.content || []).map((c) => c.text || `[${c.type}]`).join('\n') || i.error?.message) };
    case 'webSearch': return { id: i.id, name: 'Web search', detail: i.query || '', status: 'done' };
    default: return null;
  }
}

export class CodexDriver {
  constructor(opts) { this.o = opts; this.rpc = null; this.thread = null; this.turn = null; }

  async start(cwd) {
    if (this.rpc?.alive) return;
    this.thread = null;
    const rpc = spawnRpc(this.o.path, ['app-server'], {
      cwd, env: this.o.env,
      onRequest: (m, p) => this.request(m, p),
      onNotify: (m, p) => this.notify(m, p),
      onExit: (e) => { if (this.rpc === rpc) { this.rpc = null; this.turn?.finish({ status: isLimitError(e.message) ? 'limit' : 'error', error: e.message }); } },
    });
    this.rpc = rpc;
    await rpc.request('initialize', { clientInfo: { name: 'relaydeck', title: 'Relaydeck', version: this.o.version }, capabilities: null });
    rpc.notify('initialized');
  }

  async request(method, p) {
    const t = this.turn;
    if (method === 'item/commandExecution/requestApproval') {
      const r = t ? await t.onApproval({ title: 'Run a command', detail: p.command || p.reason || '', note: p.command ? p.reason : '', toolId: p.itemId, canAlways: true }) : 'deny';
      return { decision: r === 'allow' ? 'accept' : r === 'always' ? 'acceptForSession' : 'decline' };
    }
    if (method === 'item/fileChange/requestApproval') {
      const r = t ? await t.onApproval({ title: 'Edit files', detail: p.grantRoot || t.lastEdit || '', note: p.reason, toolId: p.itemId, canAlways: true }) : 'deny';
      return { decision: r === 'allow' ? 'accept' : r === 'always' ? 'acceptForSession' : 'decline' };
    }
    if (method === 'mcpServer/elicitation/request') {
      // Relaydeck's own tools ask for browser permission themselves.
      if (p.serverName === 'relaydeck' && p.mode !== 'url') return { action: 'accept', content: {}, _meta: null };
      const r = t && p.mode !== 'url' && !Object.keys(p.requestedSchema?.properties || {}).length ? await t.onApproval({ title: `Use ${p.serverName}`, detail: p.message }) : 'deny';
      return { action: r === 'deny' ? 'decline' : 'accept', content: r === 'deny' ? null : {}, _meta: null };
    }
    throw Object.assign(new Error('Not supported by Relaydeck'), { code: -32601 });
  }

  notify(method, p) {
    const t = this.turn;
    if (method === 'account/rateLimits/updated') {
      const r = p.rateLimits || {};
      if (t) {
        const w = [r.primary, r.secondary].filter(Boolean).sort((a, b) => b.usedPercent - a.usedPercent)[0];
        if (w?.resetsAt) t.resetsAt = w.resetsAt;
        t.onEvent({ type: 'limits', info: { usedPercent: w?.usedPercent, resetsAt: w?.resetsAt } });
      }
      return;
    }
    if (!t || (p.threadId && p.threadId !== this.thread)) return;
    if (method === 'item/agentMessage/delta') {
      if (t.item !== p.itemId) { t.item = p.itemId; t.onEvent({ type: 'break' }); }
      t.streamed.add(p.itemId);
      t.onEvent({ type: 'text', delta: p.delta });
    } else if (method === 'item/started' || method === 'item/completed') {
      const i = p.item || {};
      if (i.type === 'agentMessage' && method === 'item/completed' && i.text && !t.streamed.has(i.id)) { t.onEvent({ type: 'break' }); t.onEvent({ type: 'text', delta: i.text }); }
      const tool = codexTool(i);
      if (tool) {
        if (method === 'item/started') tool.status = 'running';
        t.onEvent({ type: 'tool', ...tool });
      }
      if (i.type === 'fileChange') {
        t.lastEdit = (i.changes || []).map((c) => c.path).join('\n');
        if (method === 'item/completed' && i.status === 'completed') t.onEvent({ type: 'files', paths: i.changes.map((c) => c.path) });
      }
    } else if (method === 'error' && !p.willRetry) t.err = p.error;
    else if (method === 'turn/completed') {
      const e = p.turn?.error || t.err;
      if (p.turn?.status === 'interrupted') return t.finish({ status: 'cancelled' });
      if (p.turn?.status === 'failed') {
        const limit = e?.codexErrorInfo === 'usageLimitExceeded' || e?.codexErrorInfo === 'rateLimitExceeded' || isLimitError(e?.message);
        return t.finish({ status: limit ? 'limit' : 'error', error: e?.message || 'Codex stopped with an error', resetsAt: limit ? t.resetsAt : undefined });
      }
      t.finish({ status: 'done' });
    }
  }

  async run({ prompt, cwd, mode, model, sessionId, instructions, mcp, onEvent, onApproval, signal }) {
    const m = MODES[mode] || MODES.ask;
    let finish;
    const ended = new Promise((r) => { finish = r; });
    this.turn = { onEvent, onApproval, finish, streamed: new Set() };
    const stop = () => {
      if (this.thread && this.turnId) this.rpc?.request('turn/interrupt', { threadId: this.thread, turnId: this.turnId }).catch(() => {});
      setTimeout(() => finish({ status: 'cancelled' }), 2500).unref();
    };
    try {
      await this.start(cwd);
      const base = { cwd, model: model || null, approvalPolicy: m.approvalPolicy, sandbox: m.sandbox, developerInstructions: instructions,
        config: { mcp_servers: { relaydeck: { url: mcp.url, http_headers: { Authorization: `Bearer ${mcp.token}` } } } } };
      if (!this.thread) {
        let r = null;
        if (sessionId) r = await this.rpc.request('thread/resume', { threadId: sessionId, ...base, excludeTurns: true }).catch(() => null);
        if (!r) { r = await this.rpc.request('thread/start', base); if (sessionId) onEvent({ type: 'session-lost' }); }
        this.thread = r.thread.id;
        onEvent({ type: 'session', id: this.thread });
      }
      if (signal.aborted) return { status: 'cancelled', sessionId: this.thread };
      signal.addEventListener('abort', stop);
      const r = await this.rpc.request('turn/start', { threadId: this.thread, input: [{ type: 'text', text: prompt, text_elements: [] }], cwd, approvalPolicy: m.approvalPolicy, sandboxPolicy: m.policy, model: model || null });
      this.turnId = r.turn.id;
      if (signal.aborted) stop();
      return { sessionId: this.thread, ...(await ended) };
    } catch (e) {
      return { status: isLimitError(e.message) ? 'limit' : 'error', error: e.message, sessionId: this.thread || sessionId };
    } finally { signal.removeEventListener('abort', stop); this.turn = null; this.turnId = null; }
  }
  dispose() { this.rpc?.kill(); this.rpc = null; }
}
