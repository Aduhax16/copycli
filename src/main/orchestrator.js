import { chatSummary, applyChatUpdate } from '../shared/chats.js';
// Runs chats: routes tasks to agents, keeps them aware of each other, hands work over when one runs out.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { allAgents, detect, makeDriver, probeAgent, probeAgentUsage } from './agents/registry.js';
import { parseMentions, addressed, catchUp, instructionsFor, buildPrompt, renderMessage } from './context.js';
import { BROWSER_TOOLS, normalizeUrl } from './browser-tools.js';
import { isContent } from './mcp.js';
import { TEAM_TOOLS } from './team-tools.js';

export const TOOLS = [...TEAM_TOOLS, ...BROWSER_TOOLS];
const READ_ONLY = new Set(['browser_open', 'browser_read', 'browser_find', 'browser_screenshot', 'browser_scroll', 'browser_back', 'browser_console', 'browser_tabs']);

export class Orchestrator {
  constructor({ store, emit, version, bridge, driverFactory, detector, prober, usageProber }) {
    Object.assign(this, { store, emit, version, bridge });
    this.makeDriver = driverFactory || ((d, i) => makeDriver(d, i, version));
    this.detect = detector || detect;
    this.probe = prober || (detector ? async () => ({}) : (d, i) => probeAgent(d, i, version));
    this.probeUsage = usageProber || (detector || prober ? async () => ({}) : (d, i) => probeAgentUsage(d, i, version));
    this.quotaReads = new Map();
    this.usageUpdated = new Map();
    this.usageQueried = new Map();
    this.info = new Map();     // agentId -> { models, defaultModel }
    this.usage = new Map();    // agentId -> [{ usedPercent, resetsAt, minutes }]
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
  // What to type after @. An agent the user added under that name keeps it.
  handle(id) { const h = this.def(id)?.handle; return h && !this.def(h) ? h : id; }
  key = (c, a) => `${c}/${a}`;

  async refreshAgents() {
    await Promise.all(this.defs.map(async (d) => { const s = await this.detect(d).catch(() => ({ installed: false })); if (s.path && this.status.get(d.id)?.path !== s.path) this.dropDrivers(d.id); this.status.set(d.id, s); }));
    this.emit('agents', this.agents());
    Promise.all(this.defs.map(async (d) => {
      const s = this.status.get(d.id);
      if (!s?.installed) return;
      const p = await this.probe(d, s).catch(() => null);
      if (!p) return;
      if (p.models?.length) this.info.set(d.id, { models: p.models, defaultModel: p.defaultModel || null });
      if (Array.isArray(p.usage)) this.recordUsage(d.id, p.usage);
      this.emit('agents', this.agents());
    }));
    return this.agents();
  }
  models(id) { return this.info.get(id)?.models || this.store.settings.modelLists[id] || []; }
  // The effort to send: the chosen one, if the chosen model has it.
  effort(id) {
    const e = this.store.settings.efforts[id];
    if (!e) return '';
    const model = this.store.settings.models[id] || this.info.get(id)?.defaultModel;
    const m = this.models(id).find((x) => x.id === model);
    return !m || m.efforts.includes(e) ? e : '';
  }
  recordUsage(id, windows, partial = false) {
    const good = windows.filter((w) => Number.isFinite(w.usedPercent)).map((w) => ({ ...w, usedPercent: Math.max(0, Math.min(100, w.usedPercent)) }));
    if (partial && !good.length) return;
    const key = (w) => w.id || `${w.scope || ''}:${w.minutes}`;
    const all = new Map((partial ? this.usage.get(id) || [] : []).map((w) => [key(w), w]));
    for (const w of good) all.set(key(w), { ...all.get(key(w)), ...w });
    this.usage.set(id, [...all.values()]);
    this.usageUpdated.set(id, Date.now());
    if (!partial) this.usageQueried.set(id, Date.now());
  }
  allWindows(id) {
    if (this.usageUpdated.has(id) && Date.now() - this.usageUpdated.get(id) > 15 * 60e3) return [];
    return (this.usage.get(id) || []).filter((w) => Number.isFinite(w.usedPercent) && (!w.resetsAt || w.resetsAt * 1000 > Date.now()));
  }
  windows(id) {
    const model = (this.store.settings.models[id] || this.info.get(id)?.defaultModel || '').toLowerCase();
    const scope = id === 'antigravity' && model ? /claude|gpt/.test(model) ? 'third-party' : 'gemini' : null;
    return this.allWindows(id).filter((w) => !w.scope || (id === 'antigravity' ? !scope || w.scope === scope : model.includes(w.scope)));
  }
  async refreshUsage(id, force = false) {
    const ids = id ? [id] : this.defs.filter((d) => d.kind === 'claude' || d.kind === 'codex' || d.probe === 'agy').map((d) => d.id);
    await Promise.all(ids.map((agentId) => {
      if (this.quotaReads.has(agentId)) return this.quotaReads.get(agentId);
      const def = this.def(agentId), status = this.status.get(agentId);
      if (!status?.installed || status.signedIn === false || (!force && Date.now() - (this.usageQueried.get(agentId) || 0) < 60000)) return;
      const job = Promise.resolve().then(async () => {
        try {
          const result = await this.probeUsage(def, status);
          if (Array.isArray(result.usage)) {
            this.recordUsage(agentId, result.usage);
          }
        } catch {} finally {
          this.quotaReads.delete(agentId);
          this.emit('usage', { agentId, usage: this.windows(agentId), usageDetails: this.allWindows(agentId), usageUpdatedAt: this.usageUpdated.get(agentId) });
        }
      });
      this.quotaReads.set(agentId, job);
      return job;
    }));
  }
  // How full the fullest window is.
  used(id) { const w = this.windows(id); return w.length ? Math.max(...w.map((x) => x.usedPercent)) : null; }
  dropDrivers(agentId) { for (const [k, d] of this.drivers) if (k.endsWith(`/${agentId}`) && !this.live.has(k)) { this.drivers.delete(k); d.then((x) => x.dispose()).catch(() => {}); } }
  agents() {
    const { order, disabled, models } = this.store.settings;
    const rank = (id) => { const i = order.indexOf(id); return i < 0 ? 99 : i; };
    return this.defs.map((d) => ({ id: d.id, name: d.name, color: d.color, kind: d.kind, custom: !!d.custom, aliases: d.aliases || [], handle: this.handle(d.id), install: d.install || null, site: d.site || null, canLogin: !!d.login, about: d.about || '', installed: false, ...this.status.get(d.id), enabled: !disabled.includes(d.id), model: models[d.id] || '', effort: this.store.settings.efforts[d.id] || '', models: this.models(d.id), defaultModel: this.info.get(d.id)?.defaultModel || null, usage: this.windows(d.id), usageDetails: this.allWindows(d.id), usageUpdatedAt: this.usageUpdated.get(d.id) || null, limitedUntil: (this.limited.get(d.id) || 0) > Date.now() ? this.limited.get(d.id) : null }))
      .sort((a, b) => rank(a.id) - rank(b.id));
  }
  usable() { return this.agents().filter((a) => a.installed && a.enabled && a.signedIn !== false); }

  // ---- chats ----
  listChats() { return [...this.store.chats.values()].map((c) => chatSummary(c, this.busy(c.id))).sort((a, b) => (b.updated || 0) - (a.updated || 0)); }
  chat(id) { const c = this.store.chats.get(id); if (!c) throw new Error('That chat no longer exists'); return c; }
  createChat({ cwd }) {
    const c = { id: randomUUID(), title: 'New chat', cwd: cwd || homedir(), mode: this.store.settings.defaultMode || 'ask', created: Date.now(), updated: Date.now(), messages: [], agents: {}, sites: [] };
    this.store.chats.set(c.id, c);
    this.store.save(c);
    this.emit('chats', this.listChats());
    return c;
  }
  updateChat(id, patch) {
    const c = this.chat(id);
    if (patch.cwd && patch.cwd !== c.cwd && this.busy(id)) throw new Error('Stop the agents before changing the folder');
    applyChatUpdate(c, patch);
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
    const mentioned = parseMentions(text, this.defs, usable.map((a) => a.id));
    const jobs = mentioned ? addressed(text, mentioned, this.name, (id) => this.handle(id)) : selected.filter((id) => usable.some((a) => a.id === id)).map((id) => ({ id, task: text }));
    const off = jobs.filter((j) => !usable.some((a) => a.id === j.id)).map((j) => this.name(j.id));
    if (off.length) throw new Error(`${off.join(' and ')} ${off.length > 1 ? 'are' : 'is'} not ready. Open Settings to install, sign in or turn on.`);
    if (!jobs.length) throw new Error(usable.length ? 'Choose at least one agent' : 'No agent is ready. Open Settings to install one or sign in.');
    if (chat.title === 'New chat' && !chat.customTitle) { chat.title = text.replace(/@\w+\s*/g, '').split('\n')[0].slice(0, 60) || 'New chat'; this.emit('chats', this.listChats()); }
    const round = randomUUID();
    this.push(chat, { role: 'user', text, targets: jobs.map((j) => j.id), round });
    for (const j of jobs) this.enqueue(chat, { ...j, round, tried: [] });
  }
  enqueue(chat, job) {
    const k = this.key(chat.id, job.id);
    if (this.live.has(k)) { this.queue.set(k, [...(this.queue.get(k) || []), job]); this.push(chat, { role: 'system', agentId: job.id, text: `${this.name(job.id)} is busy and will start this next.` }); return; }
    // Reserve the slot now so agents started together all see each other.
    const turn = { chatId: chat.id, agentId: job.id, task: job.part || job.task, claims: new Set(), files: new Set(), abort: new AbortController() };
    this.live.set(k, turn);
    setImmediate(() => this.runJob(chat, job, turn).catch((e) => { console.error(e); this.live.delete(k); this.push(chat, { role: 'system', agentId: job.id, level: 'error', text: `${this.name(job.id)}: ${e.message}` }); this.emit('chats', this.listChats()); }));
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
    turn.startUsage = this.windows(job.id).map((w) => ({ ...w }));
    turn.startUsed = this.used(job.id);
    turn.spend = !!job.spend;
    if (!job.spend && !(await this.mayStart(chat, job, turn))) return;
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
        if (old) Object.assign(old, set); else { msg.parts.push({ type: 'tool', name: 'Tool', ...set }); this.guard(turn); }
      } else if (e.type === 'files') this.filesTouched(chat, turn, e.paths);
      else if (e.type === 'session') { st.session = e.id; }
      else if (e.type === 'session-lost') { st.seen = []; }
      else if (e.type === 'usage') { const { type: _t, ...u } = e; msg.usage = { ...msg.usage, ...u }; }
      else if (e.type === 'models') { this.store.settings.modelLists[job.id] = e.models; this.store.saveSettings(); this.emit('agents', this.agents()); return; }
      else if (e.type === 'limits') { if (e.info.windows?.length) { this.recordUsage(job.id, e.info.windows, e.info.partial); this.guard(turn); this.emit('usage', { agentId: job.id, usage: this.windows(job.id), usageDetails: this.allWindows(job.id), usageUpdatedAt: this.usageUpdated.get(job.id) }); } return; }
      touch();
    };
    let r;
    try {
      const d = await this.driver(chat, job.id);
      r = turn.abort.signal.aborted ? { status: 'cancelled' } : await d.run({
        prompt: prompt(), cwd: chat.cwd, mode: chat.mode, model: this.store.settings.models[job.id] || '', effort: this.effort(job.id), lean: this.store.settings.leanCodex, sessionId: st.session,
        instructions: instructionsFor(def, others, chat.cwd, chat.mode, this.store.settings.instructions), mcp: { ...this.mcpFor(chat.id, job.id), bridge: this.bridge },
        onEvent, onApproval: (a) => this.askApproval(chat, job.id, a, turn.abort.signal), signal: turn.abort.signal,
      });
    } catch (e) { r = { status: 'error', error: e.message }; }
    clearTimeout(pendingTouch);
    if (turn.abort.signal.aborted) r.status = turn.paused ? 'paused' : 'cancelled';
    if (turn.paused && r.status === 'paused') { r.error = turn.paused; if (turn.pausedFor) msg.pausedFor = turn.pausedFor; }
    if (r.sessionId) st.session = r.sessionId;
    // A turn that never ran has told the agent nothing.
    if (r.status === 'done' || msg.parts.length) st.seen = [...new Set([...st.seen, ...(st.pending || []), ...chat.messages.filter((m) => m.role === 'user' && m.round === job.round).map((m) => m.id)])];
    delete st.pending;
    msg.status = r.status;
    msg.spent = this.spent(turn);
    msg.ended = Date.now();
    if (r.error) msg.error = String(r.error).slice(0, 2000);
    for (const p of msg.parts) if (p.status === 'running') p.status = r.status === 'done' ? 'done' : 'error';
    for (const [id, a] of this.approvals) if (a.chatId === chat.id && a.agentId === job.id) this.resolveApproval(id, 'deny');
    this.live.delete(k);
    this.touch(chat, msg);
    if (r.status !== 'cancelled') this.emit('turn-end', { chatId: chat.id, agentId: job.id, status: r.status });
    if (r.status === 'error' && /authentication required|not (logged|signed) in|please (log|sign) in|login required/i.test(r.error || '')) { const s = this.status.get(job.id); if (s) s.signedIn = false; }
    if (r.status === 'limit') this.handOff(chat, job, r);
    else if (r.status === 'done') this.limited.delete(job.id);
    // Work queued behind a turn paused for a question waits for the answer too.
    const next = msg.pausedFor ? null : this.queue.get(k)?.shift();
    if (next && !this.live.has(k)) this.enqueue(chat, next);
    this.emit('agents', this.agents());
    this.emit('chats', this.listChats());
    this.refreshUsage(job.id, true);
  }

  // ---- usage guard ----
  // Percent of the fullest shared window used since this turn began. Windows that reset start over.
  spent(turn) {
    const now = this.windows(turn.agentId), was = turn.startUsage || [];
    const d = now.map((w) => { const o = was.find((x) => (w.id && x.id ? w.id === x.id : x.minutes === w.minutes && x.scope === w.scope) && Math.abs((x.resetsAt || 0) - (w.resetsAt || 0)) < 120); return o ? Math.max(0, w.usedPercent - o.usedPercent) : 0; });
    return d.length ? Math.max(...d) : null;
  }
  guard(turn) {
    const g = this.store.settings.guard;
    if (!turn.startUsage?.length && this.windows(turn.agentId).length) turn.startUsage = this.windows(turn.agentId).map((w) => ({ ...w }));
    if (turn.paused || turn.abort.signal.aborted) return;
    const n = this.name(turn.agentId), spent = this.spent(turn), used = this.used(turn.agentId);
    if (!g.on || turn.spend) {
      // Never stop work the user did not ask to have stopped; just say so once.
      if (spent !== null && spent >= g.perTask && !turn.told) { turn.told = true; this.push(this.chat(turn.chatId), { role: 'system', agentId: turn.agentId, text: `${n} has used ${spent}% of your plan's limit on this task and is still working.` }); }
      return;
    }
    const actions = turn.msg?.parts.filter((p) => p.type === 'tool').length || 0;
    let why = '';
    if (spent !== null && spent >= g.perTask) why = `${n} used ${spent}% of your plan's limit on this task, so it was paused.`;
    else if (used !== null && used >= 100 - g.reserve && (turn.startUsed ?? used) < 100 - g.reserve) why = `${n} reached ${used}% of your plan's limit, so it was paused to keep the rest.`;
    else if (spent === null && actions >= g.actions) why = `${n} has taken ${actions} actions on this task, so it was paused.`;
    if (why) { turn.paused = why; turn.abort.abort(); }
  }
  async mayStart(chat, job, turn) {
    const g = this.store.settings.guard, k = this.key(chat.id, job.id);
    if (!g.on || turn.startUsed === null || turn.startUsed < 100 - g.reserve) return true;
    const ok = await this.ask(chat, job.id, { title: `Keep using ${this.name(job.id)}?`, detail: `${turn.startUsed}% of your plan's limit is already used.`, note: 'Deny to leave the rest unused. Another agent can take the task if automatic handover is on.' }, turn.abort.signal);
    if (ok !== 'deny') return true;
    this.live.delete(k);
    const next = this.usable().find((a) => ![...job.tried, job.id].includes(a.id) && !a.limitedUntil && !(this.used(a.id) >= 100 - g.reserve));
    if (!turn.abort.signal.aborted && this.store.settings.autoHandoff && next) {
      this.push(chat, { role: 'system', agentId: next.id, text: `${next.name} is taking this task to save ${this.name(job.id)}'s usage.` });
      this.enqueue(chat, { id: next.id, task: job.task, round: job.round, tried: [...job.tried, job.id] });
    } else this.push(chat, { role: 'system', agentId: job.id, text: `${this.name(job.id)} did not start.` });
    this.emit('chats', this.listChats());
    const q = this.queue.get(k)?.shift();
    if (q) this.enqueue(chat, q);
    return false;
  }

  handOff(chat, job, r) {
    const until = r.resetsAt ? (r.resetsAt > 1e12 ? r.resetsAt : r.resetsAt * 1000) : Date.now() + 30 * 60e3;
    this.limited.set(job.id, until);
    const tried = [...job.tried, job.id];
    const when = r.resetsAt ? ` until ${new Date(until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
    const free = this.usable().filter((a) => !tried.includes(a.id) && !a.limitedUntil);
    const next = free.find((a) => !this.live.has(this.key(chat.id, a.id))) || free[0];
    if (!this.store.settings.autoHandoff || !next) {
      this.push(chat, { role: 'system', agentId: job.id, level: 'limit', text: `${this.name(job.id)} ran out of usage${when}.${next ? '' : ' No other agent is free to continue.'}`, offer: next ? { task: job.task, from: job.id } : undefined });
      return;
    }
    this.push(chat, { role: 'system', agentId: next.id, level: 'limit', text: `${this.name(job.id)} ran out of usage${when}. ${next.name} is continuing.` });
    this.enqueue(chat, { id: next.id, task: job.task, round: job.round, from: job.id, tried });
  }
  continueWith(chatId, messageId, agentId) {
    const chat = this.chat(chatId), m = chat.messages.find((x) => x.id === messageId);
    if (!m || m.role !== 'agent' || !this.usable().some((a) => a.id === agentId)) throw new Error('That agent is not available');
    if (agentId === m.agentId) {
      this.push(chat, { role: 'system', agentId, text: `${this.name(agentId)} is continuing.` });
      this.enqueue(chat, { id: agentId, task: `Continue this task from where you stopped, and finish with as few steps as you can:\n\n${m.task}`, round: randomUUID(), tried: [], spend: true });
      return;
    }
    this.push(chat, { role: 'system', agentId, text: `${this.name(agentId)} is continuing ${this.name(m.agentId)}'s task.` });
    this.enqueue(chat, { id: agentId, task: m.task, round: randomUUID(), from: m.status === 'limit' ? m.agentId : undefined, tried: [m.agentId] });
  }
  // The user answers a question an agent asked in its box. Agents paused for it pick up where they stopped.
  answer(chatId, messageId, text) {
    const chat = this.chat(chatId), m = chat.messages.find((x) => x.id === messageId), q = m?.question;
    text = String(text || '').trim();
    if (!q) throw new Error('That question is no longer there');
    if (q.answer) throw new Error('That question was already answered');
    if (!text) throw new Error('Write an answer first');
    if (!this.usable().some((a) => a.id === m.agentId)) throw new Error(`${this.name(m.agentId)} is not ready. Open Settings to turn it on or sign in.`);
    Object.assign(q, { answer: text, answeredAt: Date.now() });
    this.touch(chat, m);
    const round = randomUUID();
    this.push(chat, { role: 'user', text, targets: [m.agentId], round, answers: m.id });
    this.enqueue(chat, { id: m.agentId, task: `The user answered your question.\n\nYou asked: ${q.text}\n\nThey answered: ${text}\n\nContinue your task with this.`, round, tried: [] });
    for (const x of chat.messages) if (x.pausedFor === q.id && x.status === 'paused' && !x.resumed && !this.live.has(this.key(chat.id, x.agentId))) { x.resumed = true; this.continueWith(chat.id, x.id, x.agentId); }
    this.emit('chats', this.listChats());
  }
  filesTouched(chat, turn, paths) {
    for (const raw of paths) {
      const p = this.rel(chat, raw);
      if (!turn.files.has(p)) { turn.files.add(p); turn.msg.files.push(p); }
      for (const o of this.live.values()) if (o !== turn && o.chatId === chat.id && (o.files.has(p) || o.claims.has(p)) && !turn[`w:${p}`]) {
        turn[`w:${p}`] = true;
        this.push(chat, { role: 'system', agentId: turn.agentId, level: 'warn', text: `${this.name(turn.agentId)} and ${this.name(o.agentId)} are both working on ${p}. Check the result.` });
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
    return this.ask(chat, agentId, a, signal);
  }
  ask(chat, agentId, a, signal) {
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

  // Sites the user always allows, per chat.
  sites() { return [...this.store.chats.values()].flatMap((c) => (c.sites || []).map((host) => ({ chatId: c.id, title: c.title, host }))).sort((a, b) => a.host.localeCompare(b.host)); }
  removeSite(chatId, host) { const c = this.chat(chatId); c.sites = c.sites.filter((s) => s !== host); this.store.save(c); }

  // ---- tools the agents call ----
  mcpFor(chatId, agentId) { return { url: this.mcp.url, token: this.mcp.tokenFor({ chatId, agentId }) }; }
  async callTool({ chatId, agentId }, name, a) {
    const chat = this.chat(chatId), turn = this.live.get(this.key(chatId, agentId));
    if (!turn) throw new Error('Your turn is over');
    const out = name.startsWith('team_') || name === 'ask_user' ? this.team(chat, agentId, turn, name, a) : await this.web(chat, agentId, turn, name, a);
    // Deliver teammates' notes with whatever the agent was doing.
    const st = chat.agents[agentId];
    const notes = chat.messages.filter((m) => m.note && m.agentId !== agentId && m.ts >= turn.msg.ts && !st.seen.includes(m.id));
    if (!notes.length || name === 'team_messages') return out;
    st.seen.push(...notes.map((n) => n.id));
    const extra = { type: 'text', text: `New notes from teammates:\n${notes.map((n) => renderMessage(n, this.name)).join('\n')}` };
    return [...(isContent(out) ? out : [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }]), extra];
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
      case 'ask_user': {
        const text = String(a.question || '').trim().slice(0, 4000);
        if (!text) throw new Error('Write the question');
        if (turn.msg.question && !turn.msg.question.answer) throw new Error('You already asked a question this turn. End your turn; the answer comes as your next message.');
        const q = { id: randomUUID(), text, pauseOthers: a.pause_others === true, at: Date.now() };
        turn.msg.question = q;
        this.touch(chat, turn.msg);
        const paused = [];
        if (q.pauseOthers) for (const t of mates) if (!t.abort.signal.aborted) { t.paused = `Paused until you answer ${this.name(agentId)}'s question.`; t.pausedFor = q.id; t.abort.abort(); paused.push(this.name(t.agentId)); }
        this.emit('question', { chatId: chat.id, agentId, question: text });
        return `Your question is in your box in the chat.${paused.length ? ` Paused until the user answers: ${paused.join(', ')}.` : ''} End your turn now with one short line. The user's answer will come as your next message.`;
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
    try { const r = await this.webOnce(chat, agentId, turn, name, a); turn.webErrors = 0; return r; }
    catch (e) {
      turn.webErrors = (turn.webErrors || 0) + 1;
      if (turn.webErrors >= 3) throw new Error(`${e.message}\nThe browser has failed ${turn.webErrors} times in a row. Stop retrying and do not use another browser; tell the user what failed.`);
      throw e;
    }
  }
  async webOnce(chat, agentId, turn, name, a) {
    const b = this.browser;
    if (!b || !BROWSER_TOOLS.some((t) => t.name === name)) throw new Error(`Unknown tool ${name}`);
    if (name === 'browser_steps') {
      const steps = (Array.isArray(a.steps) ? a.steps : []).slice(0, 15);
      if (!steps.length) throw new Error('Give at least one step');
      let out, i = 0;
      for (const { tool, ...args } of steps) {
        i++;
        if (turn.abort.signal.aborted) throw new Error('Stopped');
        if (!['open', 'click', 'type', 'key', 'scroll', 'back', 'find', 'read'].includes(tool)) throw new Error(`Step ${i}: unknown tool ${tool}`);
        try { out = await this.webOnce(chat, agentId, turn, `browser_${tool}`, args); } catch (e) { throw new Error(`Step ${i} (${tool}): ${e.message}`); }
      }
      return out;
    }
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
    const act = { browser_read: () => b.read(t, a), browser_find: () => b.find(t, a.text), browser_screenshot: () => b.screenshot(t), browser_click: () => b.click(t, a), browser_type: () => b.type(t, a), browser_key: async () => { await b.press(t, a.key); return b.changes(t); }, browser_scroll: () => b.scroll(t, a.direction), browser_back: async () => { b.nav(t.id, 'back'); return b.read(t); }, browser_console: () => t.logs.slice(-30).join('\n') || 'No messages.' }[name];
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
