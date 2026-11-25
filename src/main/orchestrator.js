// Runs chats: routes tasks to agents, keeps them aware of each other, hands work over when one runs out.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { allAgents, detect, makeDriver } from './agents/registry.js';
import { parseMentions, catchUp, instructionsFor, buildPrompt, renderMessage } from './context.js';
import { BROWSER_TOOLS, normalizeUrl } from './browser-tools.js';

const S = (properties = {}, required = []) => ({ type: 'object', properties, required });
export const TEAM_TOOLS = [
  { name: 'team_status', description: 'What each agent in this chat is doing now, the files it claimed and the files it changed.', inputSchema: S() },
  { name: 'team_messages', description: 'Read the recent shared chat, including work still in progress.', inputSchema: S({ count: { type: 'number' } }) },
  { name: 'team_post', description: 'Post a short note to the shared chat for the user and the other agents.', inputSchema: S({ text: { type: 'string' } }, ['text']) },
  { name: 'team_claim', description: 'Claim files before editing them while others are working. Fails, naming the owner, if a teammate holds one. Claims end with your turn.', inputSchema: S({ files: { type: 'array', items: { type: 'string' } } }, ['files']) },
  { name: 'team_release', description: 'Release files you claimed (all when left out).', inputSchema: S({ files: { type: 'array', items: { type: 'string' } } }) },
];
export const TOOLS = [...TEAM_TOOLS, ...BROWSER_TOOLS];
const READ_ONLY = new Set(['browser_open', 'browser_read', 'browser_screenshot', 'browser_scroll', 'browser_back', 'browser_console', 'browser_tabs']);

export class Orchestrator {
  constructor({ store, emit, version, bridge, driverFactory, detector }) {
    Object.assign(this, { store, emit, version, bridge });
    this.makeDriver = driverFactory || ((d, i) => makeDriver(d, i, version));
    this.detect = detector || detect;
    this.status = new Map();   // agentId -> detection
    this.limited = new Map();  // agentId -> ms until
    this.drivers = new Map();  // chat/agent -> driver promise
    this.live = new Map();     // chat/agent -> running turn
    this.queue = new Map();    // chat/agent -> [jobs]
    this.approvals = new Map();
    this.chatSeq = new Map();
  }
  get defs() { return allAgents(this.store.settings.custom); }
  def(id) { return this.defs.find((a) => a.id === id); }
  name = (id) => this.def(id)?.name || id;
  key = (c, a) => `${c}/${a}`;

  async refreshAgents() {
    await Promise.all(this.defs.map(async (d) => { const s = await this.detect(d).catch(() => ({ installed: false })); if (s.path && this.status.get(d.id)?.path !== s.path) this.dropDrivers(d.id); this.status.set(d.id, s); }));
    this.emit('agents', this.agents());
    return this.agents();
  }
  dropDrivers(agentId) { for (const [k, d] of this.drivers) if (k.endsWith(`/${agentId}`) && !this.live.has(k)) { this.drivers.delete(k); d.then((x) => x.dispose()).catch(() => {}); } }
  agents() {
    const { order, disabled, models } = this.store.settings;
    const rank = (id) => { const i = order.indexOf(id); return i < 0 ? 99 : i; };
    return this.defs.map((d) => ({ id: d.id, name: d.name, color: d.color, kind: d.kind, custom: !!d.custom, aliases: d.aliases || [], install: d.install || null, site: d.site || null, canLogin: !!d.login, installed: false, ...this.status.get(d.id), enabled: !disabled.includes(d.id), model: models[d.id] || '', limitedUntil: (this.limited.get(d.id) || 0) > Date.now() ? this.limited.get(d.id) : null }))
      .sort((a, b) => rank(a.id) - rank(b.id));
  }
  usable() { return this.agents().filter((a) => a.installed && a.enabled && a.signedIn !== false); }

  // ---- chats ----
  listChats() { return [...this.store.chats.values()].map((c) => ({ id: c.id, title: c.title, cwd: c.cwd, updated: c.updated, running: [...this.live.keys()].some((k) => k.startsWith(`${c.id}/`)) })).sort((a, b) => b.updated - a.updated); }
  chat(id) { const c = this.store.chats.get(id); if (!c) throw new Error('That chat no longer exists'); return c; }
  createChat({ cwd }) {
    const c = { id: randomUUID(), title: 'New chat', cwd: cwd || homedir(), mode: 'ask', created: Date.now(), updated: Date.now(), messages: [], agents: {}, sites: [] };
    this.store.chats.set(c.id, c);
    this.store.save(c);
    this.emit('chats', this.listChats());
    return c;
  }
  updateChat(id, patch) {
    const c = this.chat(id);
    if (typeof patch.title === 'string' && patch.title.trim()) c.title = patch.title.trim().slice(0, 80);
    if (['plan', 'ask', 'edit', 'full'].includes(patch.mode)) c.mode = patch.mode;
    // Native sessions belong to a folder, so a new folder starts them over.
    if (patch.cwd && patch.cwd !== c.cwd) { if (this.busy(id)) throw new Error('Stop the agents before changing the folder'); c.cwd = patch.cwd; this.resetSessions(c); }
    this.store.save(c);
    this.emit('chats', this.listChats());
    return c;
  }
  resetSessions(c) { for (const [k, d] of this.drivers) if (k.startsWith(`${c.id}/`)) { this.drivers.delete(k); d.then((x) => x.dispose()).catch(() => {}); } c.agents = {}; }
  busy(id) { return [...this.live.keys()].some((k) => k.startsWith(`${id}/`)); }
  deleteChat(id) { this.stop(id); const c = this.chat(id); this.resetSessions(c); this.store.remove(id); this.emit('chats', this.listChats()); }

  push(chat, m) {
    const msg = { id: randomUUID(), ts: Date.now(), ...m };
    chat.messages.push(msg);
    chat.updated = Date.now();
    this.touch(chat, msg);
    return msg;
  }
  touch(chat, msg) { this.store.save(chat); this.emit('message', { chatId: chat.id, message: msg }); }

  // ---- sending ----
  send(chatId, text, selected = []) {
    const chat = this.chat(chatId);
    text = text.trim();
    if (!text) return;
    const usable = this.usable();
    const jobs = parseMentions(text, this.defs, usable.map((a) => a.id)) || selected.filter((id) => usable.some((a) => a.id === id)).map((id) => ({ id, task: text }));
    const off = jobs.filter((j) => !usable.some((a) => a.id === j.id)).map((j) => this.name(j.id));
    if (off.length) throw new Error(`${off.join(' and ')} ${off.length > 1 ? 'are' : 'is'} not ready. Open Agents to install, sign in or turn on.`);
    if (!jobs.length) throw new Error(usable.length ? 'Choose at least one agent' : 'No agent is ready. Open Agents to install one or sign in.');
    if (chat.title === 'New chat') { chat.title = text.replace(/@\w+\s*/g, '').split('\n')[0].slice(0, 60) || 'New chat'; this.emit('chats', this.listChats()); }
    const round = randomUUID();
    this.push(chat, { role: 'user', text, targets: jobs.map((j) => j.id), round });
    for (const j of jobs) this.enqueue(chat, { ...j, round, tried: [] });
  }
  enqueue(chat, job) {
    const k = this.key(chat.id, job.id);
    if (this.live.has(k)) { this.queue.set(k, [...(this.queue.get(k) || []), job]); this.push(chat, { role: 'system', text: `${this.name(job.id)} is busy and will start this next.` }); return; }
    // Reserve the slot now so agents started together all see each other.
    const turn = { chatId: chat.id, agentId: job.id, task: job.task, claims: new Set(), files: new Set(), abort: new AbortController() };
    this.live.set(k, turn);
    setImmediate(() => this.runJob(chat, job, turn).catch((e) => { console.error(e); this.live.delete(k); this.push(chat, { role: 'system', level: 'error', text: `${this.name(job.id)}: ${e.message}` }); this.emit('chats', this.listChats()); }));
  }
  async driver(chat, id) {
    const k = this.key(chat.id, id);
    if (!this.drivers.has(k)) { const p = Promise.resolve(this.makeDriver(this.def(id), this.status.get(id))); this.drivers.set(k, p); p.catch(() => this.drivers.delete(k)); }
    return this.drivers.get(k);
  }

  async runJob(chat, job, turn) {
    const k = this.key(chat.id, job.id), def = this.def(job.id);
    const st = (chat.agents[job.id] ||= { seen: [] });
    const others = this.usable().filter((a) => a.id !== job.id);
    const working = () => [...this.live.values()].filter((t) => t.chatId === chat.id && t.agentId !== job.id).map((t) => ({ name: this.name(t.agentId), task: t.task, claims: [...t.claims] }));
    const prompt = () => {
      const c = catchUp(chat.messages.filter((m) => !(m.role === 'user' && m.round === job.round) && m !== msg), job.id, st.seen, this.name);
      st.pending = c.seen;
      return buildPrompt({ task: job.task, context: c.text, working: working(), handoff: job.from && this.name(job.from) });
    };
    const msg = this.push(chat, { role: 'agent', agentId: job.id, round: job.round, status: 'running', parts: [], files: [], task: job.task });
    turn.msg = msg;
    this.emit('chats', this.listChats());
    let pendingTouch;
    const touch = () => { pendingTouch ||= setTimeout(() => { pendingTouch = null; this.touch(chat, msg); }, 60); };
    const onEvent = (e) => {
      const last = msg.parts.at(-1);
      if (e.type === 'text') { if (last?.type === 'text' && !turn.brk) last.text += e.delta; else msg.parts.push({ type: 'text', text: e.delta }); turn.brk = false; }
      else if (e.type === 'break') turn.brk = true;
      else if (e.type === 'tool') {
        const old = msg.parts.find((p) => p.type === 'tool' && p.id === e.id);
        const { type: _t, ...f } = e;
        const set = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== ''));
        if (old) Object.assign(old, set); else msg.parts.push({ type: 'tool', name: 'Tool', ...set });
      } else if (e.type === 'files') this.filesTouched(chat, turn, e.paths);
      else if (e.type === 'session') { st.session = e.id; }
      else if (e.type === 'session-lost') { st.seen = []; }
      else if (e.type === 'limits') { turn.limits = e.info; this.emit('limits', { agentId: job.id, ...e.info }); return; }
      touch();
    };
    let r;
    try {
      const d = await this.driver(chat, job.id);
      r = turn.abort.signal.aborted ? { status: 'cancelled' } : await d.run({
        prompt: prompt(), cwd: chat.cwd, mode: chat.mode, model: this.store.settings.models[job.id] || '', sessionId: st.session,
        instructions: instructionsFor(def, others, chat.cwd, chat.mode), mcp: { ...this.mcpFor(chat.id, job.id), bridge: this.bridge },
        onEvent, onApproval: (a) => this.askApproval(chat, job.id, a, turn.abort.signal), signal: turn.abort.signal,
      });
    } catch (e) { r = { status: 'error', error: e.message }; }
    clearTimeout(pendingTouch);
    if (turn.abort.signal.aborted) r.status = 'cancelled';
    if (r.sessionId) st.session = r.sessionId;
    // A turn that never ran has told the agent nothing.
    if (r.status === 'done' || msg.parts.length) st.seen = [...new Set([...st.seen, ...(st.pending || []), ...chat.messages.filter((m) => m.role === 'user' && m.round === job.round).map((m) => m.id)])];
    delete st.pending;
    msg.status = r.status;
    msg.ended = Date.now();
    if (r.error) msg.error = String(r.error).slice(0, 2000);
    for (const p of msg.parts) if (p.status === 'running') p.status = r.status === 'done' ? 'done' : 'error';
    for (const [id, a] of this.approvals) if (a.chatId === chat.id && a.agentId === job.id) this.resolveApproval(id, 'deny');
    this.live.delete(k);
    this.touch(chat, msg);
    if (r.status === 'limit') this.handOff(chat, job, r);
    else if (r.status === 'done') this.limited.delete(job.id);
    const next = this.queue.get(k)?.shift();
    if (next && !this.live.has(k)) this.enqueue(chat, next);
    this.emit('agents', this.agents());
    this.emit('chats', this.listChats());
  }

  handOff(chat, job, r) {
    const until = r.resetsAt ? (r.resetsAt > 1e12 ? r.resetsAt : r.resetsAt * 1000) : Date.now() + 30 * 60e3;
    this.limited.set(job.id, until);
    const tried = [...job.tried, job.id];
    const when = r.resetsAt ? ` until ${new Date(until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
    const free = this.usable().filter((a) => !tried.includes(a.id) && !a.limitedUntil);
    const next = free.find((a) => !this.live.has(this.key(chat.id, a.id))) || free[0];
    if (!this.store.settings.autoHandoff || !next) {
      this.push(chat, { role: 'system', level: 'limit', text: `${this.name(job.id)} ran out of usage${when}.${next ? '' : ' No other agent is free to continue.'}`, offer: next ? { task: job.task, from: job.id } : undefined });
      return;
    }
    this.push(chat, { role: 'system', level: 'limit', text: `${this.name(job.id)} ran out of usage${when}. ${next.name} is continuing.` });
    this.enqueue(chat, { id: next.id, task: job.task, round: job.round, from: job.id, tried });
  }
  continueWith(chatId, messageId, agentId) {
    const chat = this.chat(chatId), m = chat.messages.find((x) => x.id === messageId);
    if (!m || m.role !== 'agent' || !this.usable().some((a) => a.id === agentId)) throw new Error('That agent is not available');
    this.push(chat, { role: 'system', text: `${this.name(agentId)} is continuing ${this.name(m.agentId)}'s task.` });
    this.enqueue(chat, { id: agentId, task: m.task, round: randomUUID(), from: m.status === 'limit' ? m.agentId : undefined, tried: [m.agentId] });
  }
  filesTouched(chat, turn, paths) {
    for (const raw of paths) {
      const p = this.rel(chat, raw);
      if (!turn.files.has(p)) { turn.files.add(p); turn.msg.files.push(p); }
      for (const o of this.live.values()) if (o !== turn && o.chatId === chat.id && (o.files.has(p) || o.claims.has(p)) && !turn[`w:${p}`]) {
        turn[`w:${p}`] = true;
        this.push(chat, { role: 'system', level: 'warn', text: `${this.name(turn.agentId)} and ${this.name(o.agentId)} are both working on ${p}. Check the result.` });
      }
    }
  }
  rel(chat, p) { const a = path.resolve(chat.cwd, p), r = path.relative(chat.cwd, a); return r && !r.startsWith('..') ? r : a; }

  stop(chatId, agentId) {
    for (const [k, t] of this.live) if (t.chatId === chatId && (!agentId || t.agentId === agentId)) { this.queue.delete(k); t.abort.abort(); }
    for (const [id, a] of this.approvals) if (a.chatId === chatId && (!agentId || a.agentId === agentId)) this.resolveApproval(id, 'deny');
  }

  // ---- approvals ----
  askApproval(chat, agentId, a, signal) {
    if (chat.mode === 'plan') return Promise.resolve('deny');
    if (chat.mode === 'full') return Promise.resolve('allow');
    if (signal?.aborted) return Promise.resolve('deny');
    return new Promise((resolve) => {
      const id = randomUUID();
      const view = { id, chatId: chat.id, agentId, title: a.title, detail: String(a.detail || '').slice(0, 6000), note: a.note || '', canAlways: !!a.canAlways, alwaysLabel: a.alwaysLabel || 'Always in this chat' };
      this.approvals.set(id, { ...view, resolve });
      this.emit('approval', view);
    });
  }
  resolveApproval(id, decision) {
    const a = this.approvals.get(id);
    if (!a) return;
    this.approvals.delete(id);
    this.emit('approval-done', { id });
    a.resolve(['allow', 'always'].includes(decision) ? decision : 'deny');
  }
  pendingApprovals(chatId) { return [...this.approvals.values()].filter((a) => a.chatId === chatId).map(({ resolve, ...v }) => v); }

  // ---- tools the agents call ----
  mcpFor(chatId, agentId) { return { url: this.mcp.url, token: this.mcp.tokenFor({ chatId, agentId }) }; }
  async callTool({ chatId, agentId }, name, a) {
    const chat = this.chat(chatId), turn = this.live.get(this.key(chatId, agentId));
    if (!turn) throw new Error('Your turn is over');
    const out = name.startsWith('team_') ? this.team(chat, agentId, turn, name, a) : await this.web(chat, agentId, turn, name, a);
    // Deliver teammates' notes with whatever the agent was doing.
    const st = chat.agents[agentId];
    const notes = chat.messages.filter((m) => m.note && m.agentId !== agentId && m.ts >= turn.msg.ts && !st.seen.includes(m.id));
    if (!notes.length || name === 'team_messages') return out;
    st.seen.push(...notes.map((n) => n.id));
    const extra = { type: 'text', text: `New notes from teammates:\n${notes.map((n) => renderMessage(n, this.name)).join('\n')}` };
    return [...(Array.isArray(out) ? out : [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }]), extra];
  }
  team(chat, agentId, turn, name, a) {
    const files = (Array.isArray(a.files) ? a.files : []).map((f) => this.rel(chat, String(f)));
    const mates = [...this.live.values()].filter((t) => t.chatId === chat.id && t !== turn);
    switch (name) {
      case 'team_status': return { folder: chat.cwd, you: { claimed: [...turn.claims], changed: [...turn.files] }, teammates: mates.map((t) => ({ agent: this.name(t.agentId), task: t.task.slice(0, 600), claimed: [...t.claims], changed: [...t.files], doing: t.msg?.parts.filter((p) => p.type === 'tool').slice(-3).map((p) => `${p.name} ${String(p.detail || '').split('\n')[0].slice(0, 120)} (${p.status})`) })), idle: this.usable().filter((u) => u.id !== agentId && !mates.some((t) => t.agentId === u.id)).map((u) => u.name) };
      case 'team_messages': return chat.messages.slice(-Math.min(Math.max(Number(a.count) || 20, 1), 100)).map((m) => renderMessage(m, this.name, 4000)).join('\n\n');
      case 'team_post': {
        const text = String(a.text || '').trim().slice(0, 4000);
        if (!text) throw new Error('Nothing to post');
        this.push(chat, { role: 'agent', agentId, note: true, status: 'done', parts: [{ type: 'text', text }], files: [] });
        return 'Posted.';
      }
      case 'team_claim': {
        const taken = files.flatMap((f) => mates.filter((t) => t.claims.has(f)).map((t) => `${f} (${this.name(t.agentId)})`));
        if (taken.length) throw new Error(`Already claimed: ${taken.join(', ')}. Nothing was claimed. Work on something else or post a note.`);
        files.forEach((f) => turn.claims.add(f));
        return `Claimed ${files.join(', ') || 'nothing'}.`;
      }
      case 'team_release': (files.length ? files : [...turn.claims]).forEach((f) => turn.claims.delete(f)); return 'Released.';
      default: throw new Error(`Unknown tool ${name}`);
    }
  }
  async allowSite(chat, agentId, turn, url) {
    if (url === 'about:blank' || !url) return;
    const host = new URL(url).host;
    if (chat.mode === 'full' || chat.sites.includes(host)) return;
    const ok = chat.mode === 'plan' ? await this.askPlanSite(chat, agentId, host, turn) : await this.askApproval(chat, agentId, { title: `Use the browser on ${host}`, detail: url, note: 'The agent can read this site and act on it with any sign-in you have in the built-in browser.', canAlways: true, alwaysLabel: 'Always on this site' }, turn.abort.signal);
    if (ok === 'deny') throw new Error(`The user did not allow the browser on ${host}.`);
    if (ok === 'always') { chat.sites.push(host); this.store.save(chat); } else (turn.sites ||= new Set()).add(host);
  }
  askPlanSite(chat, agentId, host, turn) { return this.askApproval({ ...chat, mode: 'ask' }, agentId, { title: `Read ${host} in the browser`, detail: host, canAlways: true, alwaysLabel: 'Always on this site' }, turn.abort.signal); }
  async web(chat, agentId, turn, name, a) {
    const b = this.browser;
    if (!b || !BROWSER_TOOLS.some((t) => t.name === name)) throw new Error(`Unknown tool ${name}`);
    if (chat.mode === 'plan' && !READ_ONLY.has(name)) throw new Error('Plan mode: the browser can only be read.');
    const owner = `${chat.id}/${agentId}`;
    if (name === 'browser_tabs') return b.state().tabs.filter((t) => t.owner === owner).map(({ id, url, title }) => ({ id, url, title }));
    const gate = (url) => { let h; try { h = new URL(url).host; } catch {} return turn.sites?.has(h) ? null : this.allowSite(chat, agentId, turn, url); };
    this.emit('browser:used', { chatId: chat.id, agentId });
    if (name === 'browser_open') {
      await gate(normalizeUrl(a.url));
      if (a.new_tab) b.agentTab.delete(owner);
      const t = this.ownTab(b, owner, a.tab, true);
      const out = await b.open(t, a.url);
      await gate(t.wc.getURL()); // it may have redirected
      return out;
    }
    const t = this.ownTab(b, owner, a.tab, false);
    await gate(t.wc.getURL());
    const act = { browser_read: () => b.read(t), browser_screenshot: () => b.screenshot(t), browser_click: () => b.click(t, a), browser_type: () => b.type(t, a), browser_key: async () => { await b.press(t, a.key); return b.read(t); }, browser_scroll: () => b.scroll(t, a.direction), browser_back: async () => { b.nav(t.id, 'back'); return b.read(t); }, browser_console: () => t.logs.slice(-60).join('\n') || 'No messages.' }[name];
    const out = await act();
    await gate(t.wc.getURL());
    return out;
  }
  // Agents only get tabs they opened, or ones the user handed them.
  ownTab(b, owner, id, make) {
    if (id && b.tabs.get(id) && b.tabs.get(id).owner !== owner) throw new Error(`Tab ${id} is not yours. Ask the user to share it.`);
    return b.tabFor(owner, id, make);
  }
  shareTab(tabId, chatId, agentId) { const t = this.browser.tabs.get(tabId); if (!t) return; t.owner = `${chatId}/${agentId}`; this.browser.agentTab.set(t.owner, tabId); this.browser.changed(); }

  shutdown() { for (const t of this.live.values()) t.abort.abort(); for (const d of this.drivers.values()) d.then((x) => x.dispose()).catch(() => {}); this.store.flushAll(); }
}
