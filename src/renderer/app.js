import { markdown } from './markdown.js';
import { createSettings } from './settings.js';
const $ = (id) => document.getElementById(id);
const h = (tag, props = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (v === undefined || v === null || v === false) continue; if (k.startsWith('on')) e[k] = v; else if (k === 'class') e.className = v; else if (k === 'c') e.style.setProperty('--c', v); else if (k in e && k !== 'list') e[k] = v; else e.setAttribute(k, v); } e.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false)); return e; };
let agents = [], chats = [], chat = null, approvals = [], tabs = { tabs: [], active: null }, settings = {}, home = '', version = '';
let picked = new Set(JSON.parse(localStorage.picked || '[]'));
let toastTimer;
const toast = (t) => { $('toast').textContent = t; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); };
const call = (...a) => window.deck.call(...a).catch((e) => { toast(e.message); throw e; });
const go = (...a) => { call(...a).catch(() => {}); };
const agent = (id) => agents.find((a) => a.id === id) || { id, name: id, color: '#888' };
const ready = () => agents.filter((a) => a.installed && a.enabled && a.signedIn !== false);
const dot = (id, live) => h('span', { class: `dot${live ? ' live' : ''}`, c: agent(id).color });
const nice = (p) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);

// Small local SVGs keep the app crisp at every display scale, without a network font.
const icons = {
  layers: ['M4 7l8-4 8 4-8 4-8-4Z', 'm4 12 8 4 8-4', 'm4 17 8 4 8-4'],
  plus: ['M12 5v14', 'M5 12h14'],
  settings: ['M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  panel: ['M4 4h16v16H4z', 'M14 4v16'],
  folder: ['M3 6h7l2 2h9v12H3z'],
  'arrow-up': ['M12 19V5', 'm6 11 6-6 6 6'],
  code: ['m8 7-5 5 5 5', 'm16 7 5 5-5 5', 'm14 4-4 16'],
  search: ['M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0', 'm15 15 6 6'],
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  for (const d of icons[name] || icons.layers) { const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
document.querySelectorAll('[data-icon]').forEach((e) => e.replaceWith(icon(e.dataset.icon)));
const readyBadges = () => h('div', { class: 'ready-agents', 'aria-label': 'Available agents' }, ready().map((a) => h('span', { class: 'ready-agent' }, dot(a.id), a.name)));
function starter(name, detail, glyph, prompt) {
  return h('button', { class: 'starter', onclick: () => { $('input').value = prompt; fit(); $('input').focus(); } }, icon(glyph), h('span', {}, name, h('small', {}, detail)));
}
function composerHint() { $('send-hint').textContent = settings.sendKey === 'mod' ? `${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} + Enter to send` : 'Enter to send'; }


// ---- sidebar ----
function drawChats() {
  $('chat-count').textContent = chats.length || '';
  $('chats').replaceChildren(...chats.map((c) => h('div', { class: `chat${chat?.id === c.id ? ' on' : ''}` },
    h('button', { class: 'open', 'aria-current': chat?.id === c.id ? 'page' : undefined, onclick: () => open(c.id) }, h('div', { class: 't' }, c.title), h('div', { class: 'f' }, nice(c.cwd))),
    c.running ? h('span', { class: 'dot live' }) : null,
    h('button', { class: 'x', title: 'Delete chat', 'aria-label': `Delete ${c.title}`, onclick: async () => { if (await call('chat:delete', c.id) && chat?.id === c.id) { chat = null; drawChat(); } } }, '✕'))));
  $('stop').hidden = !chats.find((c) => c.id === chat?.id)?.running;
}
async function open(id) {
  const r = await call('chat:open', id);
  chat = r.chat; approvals = r.approvals;
  localStorage.last = id;
  drawChat(); drawChats();
  $('log').scrollTop = 1e9;
  $('input').focus();
}
async function newChat() { const c = await call('chat:new'); if (c) open(c.id); }

// ---- chat ----
const cards = new Map();
function drawChat() {
  cards.clear();
  for (const x of ['title', 'folder', 'composer', 'composer-hint']) $(x).hidden = !chat;
  composerHint();
  if (!chat) {
    const n = ready();
    $('log').replaceChildren(h('div', { class: 'empty' },
      h('div', { class: 'welcome-mark' }, icon('layers')),
      h('div', { class: 'eyebrow' }, 'One workspace. Your agents.'),
      h('h1', {}, 'Good work starts here.'),
      h('p', {}, n.length ? 'Bring your coding agents together. One conversation, a shared folder, and room to build.' : 'Connect your first coding agent in Settings, then choose a folder to start building.'),
      h('button', { class: 'primary', onclick: n.length ? newChat : () => prefs.open('agents') }, icon(n.length ? 'plus' : 'settings'), n.length ? 'Start a conversation' : 'Connect an agent'), readyBadges()));
    drawApprovals();
    return;
  }
  $('title').value = chat.title; $('folder').replaceChildren(icon('folder'), h('span', { class: 'folder-name' }, nice(chat.cwd))); $('folder').title = `Change folder · ${chat.cwd}`; $('mode').value = chat.mode;
  $('log').replaceChildren();
  chat.messages.forEach(place);
  if (!chat.messages.length) $('log').append(h('div', { class: 'empty' },
    h('div', { class: 'welcome-mark' }, icon('layers')), h('div', { class: 'eyebrow' }, 'Your next idea starts here'),
    h('h1', {}, 'What are we building?'), h('p', {}, 'Pick your agents below. Give them one goal or a task each — they’ll work together in this folder.'),
    h('div', { class: 'starter-grid' },
      starter('Build something', 'Turn an idea into working code', 'code', 'Help me build '),
      starter('Explore this project', 'Understand the code and structure', 'search', 'Explore this project and explain its structure and how to run it.'))));
  drawTargets(); drawApprovals();
}
function place(m) {
  $('log').querySelector('.empty')?.remove();
  const old = cards.get(m.id);
  const keep = old && new Set([...old.querySelectorAll('details[open]')].map((d) => d.dataset.id));
  const n = m.role === 'user' ? userCard(m) : m.role === 'system' ? sysCard(m) : agentCard(m, keep);
  cards.set(m.id, n);
  if (old) return old.replaceWith(n);
  if (m.role === 'agent' && !m.note && m.round) {
    const last = $('log').lastElementChild;
    let r = [...$('log').querySelectorAll('.round')].find((x) => x.dataset.round === m.round);
    // Later work in the same round (a handoff) starts a new row.
    if (!r || (r !== last && last?.classList.contains('limit'))) { r = h('div', { class: 'round' }); r.dataset.round = m.round; $('log').querySelectorAll('.round').forEach((x) => { if (x.dataset.round === m.round) x.dataset.round += '-done'; }); $('log').append(r); }
    r.append(n);
  } else $('log').append(n);
}
const userCard = (m) => h('div', { class: 'user' }, h('div', { class: 'to' }, `To ${m.targets.map((t) => agent(t).name).join(', ')}`), h('div', { class: 'bubble' }, m.text));
const sysCard = (m) => h('div', { class: `sys ${m.level || ''}` }, m.text);
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0));
const spend = (m) => { const u = m.usage; const bits = []; if (u) bits.push(`${tok((u.fresh || 0) + (u.output || 0))} tokens`, u.cached ? `${tok(u.cached)} cached` : '', u.calls ? `${u.calls} calls` : ''); if (m.spent) bits.push(`${m.spent}% of limit`); return bits.filter(Boolean).join(' · '); };
const span = (min) => (min >= 10080 ? 'week' : min >= 60 ? `${Math.round(min / 60)} h` : `${min} min`);
const STATE = { running: 'Working', paused: 'Paused', limit: 'Out of usage', error: 'Stopped', cancelled: 'Stopped by you' };
function agentCard(m, keep = new Set()) {
  const a = agent(m.agentId), live = m.status === 'running';
  const others = ready().filter((x) => x.id !== m.agentId);
  const body = h('div', { class: 'body' });
  for (const p of m.parts) {
    if (p.type === 'text') body.append(markdown(p.text));
    else {
      const d = h('details', { class: 'tool', open: keep.has(p.id) }, h('summary', {}, h('span', { class: `mark ${p.status}` }, p.status === 'done' ? '✓' : p.status === 'error' ? '✕' : '…'), h('b', {}, p.name.replace(/^mcp__copycli__/, '')), p.detail ? h('code', {}, p.detail.split('\n')[0]) : null));
      d.dataset.id = p.id;
      const full = [p.detail?.includes('\n') || p.detail?.length > 80 ? p.detail : '', p.output].filter(Boolean).join('\n\n');
      if (full) d.append(h('pre', {}, full));
      body.append(d);
    }
  }
  if (live && !m.parts.length) body.append(h('span', { class: 'dim' }, 'Starting…'));
  if (m.error) body.append(h('p', { class: `err ${m.status}` }, m.error));
  const more = h('select', { 'aria-label': 'Continue with another agent', onchange: (e) => { if (e.target.value) go('continue', chat.id, m.id, e.target.value); e.target.value = ''; } }, h('option', { value: '' }, 'Continue with…'), others.map((o) => h('option', { value: o.id }, o.name)));
  return h('article', { class: `agent${m.note ? ' note' : ''}` },
    h('header', {}, dot(m.agentId, live), a.name, h('span', { class: `state ${m.status}` }, m.note ? 'Note to the team' : STATE[m.status] || ''), h('span', { class: 'grow' }), live ? h('button', { class: 'quiet', onclick: () => go('stop', chat.id, m.agentId) }, 'Stop') : null, m.status === 'paused' ? h('button', { onclick: () => go('continue', chat.id, m.id, m.agentId) }, 'Continue') : null, live ? null : !m.note && others.length && m.status !== 'done' ? more : null),
    body, m.files?.length ? h('div', { class: 'files' }, `Changed ${m.files.join(', ')}`) : null, spend(m) ? h('div', { class: 'files spend' }, spend(m)) : null);
}

// ---- composer ----
function drawTargets() {
  const r = ready();
  if (![...picked].some((id) => r.some((a) => a.id === id)) && r[0]) picked = new Set([r[0].id]);
  $('targets').replaceChildren(...r.map((a) => h('button', { type: 'button', class: 'chip', c: a.color, 'aria-pressed': String(picked.has(a.id)), onclick: () => { picked.has(a.id) ? picked.delete(a.id) : picked.add(a.id); localStorage.picked = JSON.stringify([...picked]); drawTargets(); } }, dot(a.id), a.name, a.limitedUntil ? h('span', { class: 'lim' }, 'limit') : a.usage.length ? h('span', { class: Math.max(...a.usage.map((u) => u.usedPercent)) >= 80 ? 'lim' : 'pct', title: usageText(a) }, `${Math.max(...a.usage.map((u) => u.usedPercent))}%`) : null)), ...(r.length ? [] : [h('button', { type: 'button', onclick: () => prefs.open('agents') }, 'Set up an agent')]));
  $('models').replaceChildren(...r.filter((a) => picked.has(a.id) && a.models.length).map((a) => h('span', { class: 'mset' }, r.filter((x) => picked.has(x.id)).length > 1 ? h('span', { class: 'dim' }, a.name) : null, ...pickers(a))));
}
const usageText = (a) => a.usage.map((u) => `${u.usedPercent}% of the ${span(u.minutes)} limit${u.resetsAt ? `, resets ${new Date(u.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`).join(' · ');
// Model and effort menus for one agent, used under the message box and in Settings.
function pickers(a) {
  const def = a.models.find((m) => m.id === a.defaultModel)?.name || a.defaultModel;
  const known = !a.model || a.models.some((m) => m.id === a.model);
  const cur = a.models.find((m) => m.id === (a.model || a.defaultModel));
  const efforts = cur?.efforts || [];
  return [h('select', { 'aria-label': `${a.name} model`, title: cur?.desc || '', onchange: (e) => go('agents:set', a.id, { model: e.target.value }) }, h('option', { value: '', selected: !a.model }, def ? `Default (${def})` : 'Default model'), known ? null : h('option', { value: a.model, selected: true }, a.model), a.models.map((m) => h('option', { value: m.id, selected: m.id === a.model, title: m.desc || '' }, m.name))),
    efforts.length ? h('select', { 'aria-label': `${a.name} effort`, title: 'Less effort uses less of your limit', onchange: (e) => go('agents:set', a.id, { effort: e.target.value }) }, h('option', { value: '', selected: !a.effort }, 'Default effort'), efforts.map((x) => h('option', { value: x, selected: x === a.effort }, `${x[0].toUpperCase()}${x.slice(1)} effort`))) : null].filter(Boolean);
}
const fit = () => { const i = $('input'); i.style.height = 'auto'; i.style.height = `${i.scrollHeight}px`; };
async function send() {
  const text = $('input').value;
  if (!chat || !text.trim()) return;
  await call('send', chat.id, text, [...picked]);
  $('input').value = ''; fit(); $('mentions').hidden = true;
}
let mIdx = 0;
function mentions() {
  const i = $('input'), m = /(^|[\s(,])@(\w*)$/.exec(i.value.slice(0, i.selectionStart));
  const list = m ? ready().filter((a) => a.id.startsWith(m[2].toLowerCase()) || a.name.toLowerCase().startsWith(m[2].toLowerCase())) : [];
  if (m && ready().length > 1 && 'all'.startsWith(m[2].toLowerCase())) list.push({ id: 'all', name: 'All', color: '#888' });
  $('mentions').hidden = !list.length;
  mIdx = Math.min(mIdx, Math.max(0, list.length - 1));
  $('mentions').replaceChildren(...list.map((a, k) => h('button', { type: 'button', class: k === mIdx ? 'on' : '', onmousedown: (e) => { e.preventDefault(); pick(a.id, m); } }, h('span', { class: 'dot', c: a.color }), a.name, h('span', { class: 'dim' }, `@${a.id}`))));
  return { list, m };
}
function pick(id, m) { const i = $('input'), s = i.selectionStart; i.setRangeText(`@${id} `, s - m[2].length - 1, s, 'end'); mIdx = 0; mentions(); }
$('input').addEventListener('input', () => { fit(); mentions(); });
$('input').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (!$('mentions').hidden) {
    const { list, m } = mentions();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mIdx = (mIdx + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length; mentions(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(list[mIdx].id, m); return; }
    if (e.key === 'Escape') { $('mentions').hidden = true; return; }
  }
  if (e.key === 'Enter' && (settings.sendKey === 'mod' ? e.metaKey || e.ctrlKey : !e.shiftKey)) { e.preventDefault(); send().catch(() => {}); }
});
$('composer').onsubmit = (e) => { e.preventDefault(); send().catch(() => {}); };
$('stop').onclick = () => go('stop', chat.id);
$('mode').onchange = async (e) => { try { const c = await call('chat:update', chat.id, { mode: e.target.value }); chat.mode = c.mode; if (c.mode === 'full') toast('Full access: agents can run any command and use any site without asking.'); } catch {} };
$('title').onchange = (e) => go('chat:update', chat.id, { title: e.target.value });
$('folder').onclick = async () => { const c = await call('chat:folder', chat.id).catch(() => null); if (c) { chat = c; drawChat(); } };

// ---- approvals ----
function drawApprovals() {
  $('approvals').replaceChildren(...approvals.filter((a) => a.chatId === chat?.id).map((a) => h('div', { class: 'ask' }, h('div', { class: 'row' }, dot(a.agentId), h('b', {}, `${agent(a.agentId).name}: ${a.title}`)), a.detail ? h('pre', {}, a.detail) : null, a.note ? h('div', { class: 'dim' }, a.note) : null,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => go('approve', a.id, 'allow') }, 'Allow once'), a.canAlways ? h('button', { onclick: () => go('approve', a.id, 'always') }, a.alwaysLabel) : null, h('button', { class: 'bad', onclick: () => go('approve', a.id, 'deny') }, 'Deny')))));
}

// ---- settings ----
const prefs = createSettings({ root: $('settings'), h, call, go, pickers, span, state: () => ({ agents, settings, version }), save: async (p) => { settings = await call('settings:set', p); composerHint(); }, onToggle: (on) => { for (const x of ['side', 'main', 'web']) $(x).inert = on; layout(); } });
$('settings-btn').onclick = () => prefs.open();
$('new').onclick = () => newChat().catch(() => {});

// ---- browser ----
function layout() {
  const on = !$('web').hidden && !prefs.isOpen && tabs.active;
  const r = $('view').getBoundingClientRect();
  window.deck.call('browser:bounds', on ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
}
function toggleWeb(show = $('web').hidden, fresh = true) {
  $('web').hidden = $('grip').hidden = !show;
  $('browser-btn').setAttribute('aria-expanded', String(show));
  if (show && fresh && !tabs.tabs.length) go('browser:new');
  layout();
}
function drawWeb() {
  const own = (t) => t.owner?.split('/')[1];
  $('tabs').replaceChildren(...tabs.tabs.map((t) => h('div', { class: `tab${t.id === tabs.active ? ' on' : ''}` }, own(t) ? h('span', { class: `dot${t.loading ? ' live' : ''}`, c: agent(own(t)).color, title: `${agent(own(t)).name}'s tab` }) : null, h('button', { class: 'n', onclick: () => go('browser:select', t.id) }, t.title), h('button', { class: 'x', 'aria-label': 'Close tab', onclick: () => go('browser:close', t.id) }, '✕'))), h('button', { class: 'quiet', 'aria-label': 'New tab', onclick: () => go('browser:new') }, '+'));
  const t = tabs.tabs.find((x) => x.id === tabs.active);
  if (document.activeElement !== $('url')) $('url').value = t?.url === 'about:blank' ? '' : t?.url || '';
  document.querySelector('[data-nav=back]').disabled = !t?.back; document.querySelector('[data-nav=forward]').disabled = !t?.forward;
  $('share').hidden = !t || !chat;
  $('share').replaceChildren(h('option', { value: '' }, own(t || {}) ? `${agent(own(t)).name}'s tab` : 'Share with…'), ...ready().map((a) => h('option', { value: a.id }, a.name)));
  layout();
}
$('share').onchange = (e) => { if (e.target.value) go('browser:share', tabs.active, chat.id, e.target.value); };
$('url').onkeydown = (e) => { if (e.key === 'Enter') { go('browser:go', tabs.active, e.target.value); e.target.blur(); } };
document.querySelectorAll('[data-nav]').forEach((b) => { b.onclick = () => go('browser:nav', tabs.active, b.dataset.nav); });
$('browser-btn').onclick = () => toggleWeb();
new ResizeObserver(layout).observe($('view'));
addEventListener('resize', layout);
$('grip').onpointerdown = (e) => { $('grip').setPointerCapture(e.pointerId); $('grip').onpointermove = (m) => { $('web').style.width = `${Math.max(300, Math.min(innerWidth - 580, innerWidth - m.clientX))}px`; }; $('grip').onpointerup = () => { $('grip').onpointermove = null; }; };
document.addEventListener('click', (e) => { const a = e.target.closest('a[href]'); if (!a) return; e.preventDefault(); if (e.metaKey) return go('external', a.href); toggleWeb(true, false); go('browser:go', null, a.href); });

// ---- events ----
window.deck.on((ch, d) => {
  if (ch === 'agents') { agents = d; if (chat) drawTargets(); else drawChat(); prefs.refresh(); drawWeb(); }
  if (ch === 'chats') { chats = d; const c = chats.find((x) => x.id === chat?.id); if (c && document.activeElement !== $('title')) $('title').value = c.title; drawChats(); }
  if (ch === 'message' && d.chatId === chat?.id) {
    const log = $('log'), atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
    const i = chat.messages.findIndex((m) => m.id === d.message.id);
    if (i < 0) chat.messages.push(d.message); else chat.messages[i] = d.message;
    place(d.message);
    if (atEnd || d.message.role === 'user') log.scrollTop = 1e9;
  }
  if (ch === 'usage') { const a = agents.find((x) => x.id === d.agentId); if (a) { a.usage = d.usage; if (chat) drawTargets(); prefs.refresh(); } }
  if (ch === 'approval') { approvals.push(d); drawApprovals(); if (d.chatId !== chat?.id) toast(`${agent(d.agentId).name} needs your approval in another chat`); }
  if (ch === 'approval-done') { approvals = approvals.filter((a) => a.id !== d.id); drawApprovals(); }
  if (ch === 'browser:state') { tabs = d; drawWeb(); }
  if (ch === 'browser:used' && settings.autoBrowser && d.chatId === chat?.id && $('web').hidden && !layout.seen) { layout.seen = true; toggleWeb(true, false); }
  if (ch === 'browser:notice') toast(d);
  if (ch === 'open-chat') { prefs.close(); if (chats.some((c) => c.id === d)) open(d); }
  if (ch === 'menu') ({ new: () => { prefs.close(); newChat().catch(() => {}); }, settings: () => prefs.open(), browser: () => { if (!prefs.isOpen) toggleWeb(); }, stop: () => chat && go('stop', chat.id) })[d]();
});
const s = await call('init');
({ agents, chats, settings, home, version } = s); tabs = s.browser;
$('app-version').textContent = `v${version}`;
drawChats();
if (localStorage.last && chats.some((c) => c.id === localStorage.last)) await open(localStorage.last); else drawChat();
drawWeb();
