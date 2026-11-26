import { remainingPercent, quotaTooltip } from '../shared/usage.js';
import { markdown } from './markdown.js';
import { createSettings } from './settings.js';
import { createAgentStatus } from './agent-status.js';
import { createLanes } from './lanes.js';
import { createChatSidebar } from './chat-sidebar.js';
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
const brandLogo = () => h('img', { src: 'logo.svg', alt: '', class: 'logo-img' });
const readyBadges = () => h('div', { class: 'ready-agents', 'aria-label': 'Available agents' }, ready().map((a) => h('span', { class: 'ready-agent' }, dot(a.id), a.name)));
function starter(name, detail, glyph, prompt) {
  return h('button', { class: 'starter', onclick: () => { $('input').value = prompt; fit(); $('input').focus(); } }, icon(glyph), h('span', {}, name, h('small', {}, detail)));
}
function composerHint() { $('send-hint').textContent = settings.sendKey === 'mod' ? `${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} + Enter to send` : 'Enter to send'; }


// ---- sidebar ----
let sidebarModal = false;
const sidebar = createChatSidebar({
  root: $('chats'), h, nice,
  onOpen: (id) => open(id).catch(() => {}),
  onUpdate: async (id, patch) => {
    const c = await call('chat:update', id, patch);
    const meta = { title: c.title, pinned: !!c.pinned, archived: !!c.archived, group: c.group || '' };
    if (chat?.id === id) { Object.assign(chat, meta); $('title').value = c.title; }
    return meta;
  },
  onDelete: async (id) => {
    const deleted = await call('chat:delete', id);
    if (deleted && chat?.id === id) { chat = null; drawChat(); drawChats(); }
    return deleted;
  },
  onModal: (on) => { sidebarModal = on; layout(); },
});
function drawChats() {
  sidebar.render(chats, chat?.id);
  $('stop').hidden = !chats.find((c) => c.id === chat?.id)?.running;
}

async function open(id) {
  const r = await call('chat:open', id);
  chat = r.chat; approvals = r.approvals;
  localStorage.last = id;
  drawChat(); drawChats();
  $('log').scrollTop = 0;
  $('input').focus();
}
async function newChat() { const c = await call('chat:new'); if (c) open(c.id); }

// ---- chat ----
const lanesRoot = h('div', { class: 'lanes-wrap' });
const lanes = createLanes({ root: lanesRoot, h, agent, ready: () => ready(), dot, markdown, go, call, sendKey: () => settings.sendKey });
const agentStatus = createAgentStatus({
  root: $('agent-status'),
  h,
  agent,
  dot,
  onSelect: (id) => lanes.reveal(id),
});
function drawChat() {
  for (const x of ['title', 'folder', 'composer', 'composer-hint']) $(x).hidden = !chat;
  composerHint();
  if (!chat) {
    agentStatus.render(null);
    const n = ready();
    $('log').replaceChildren(h('div', { class: 'empty' },
      h('div', { class: 'welcome-mark' }, brandLogo()),
      h('div', { class: 'eyebrow' }, 'One workspace. Your agents.'),
      h('h1', {}, 'Good work starts here.'),
      h('p', {}, n.length ? 'Bring your coding agents together. One conversation, a shared folder, and room to build.' : 'Connect your first coding agent in Settings, then choose a folder to start building.'),
      h('button', { class: 'primary', onclick: n.length ? newChat : () => prefs.open('agents') }, icon(n.length ? 'plus' : 'settings'), n.length ? 'Start a conversation' : 'Connect an agent'), readyBadges()));
    drawApprovals();
    return;
  }
  $('title').value = chat.title; $('folder').replaceChildren(icon('folder'), h('span', { class: 'folder-name' }, nice(chat.cwd))); $('folder').title = `Change folder · ${chat.cwd}`; $('mode').value = chat.mode;
  lanes.render(chat);
  $('log').replaceChildren(lanesRoot);
  if (!chat.messages.length) $('log').replaceChildren(h('div', { class: 'empty' },
    h('div', { class: 'welcome-mark' }, brandLogo()), h('div', { class: 'eyebrow' }, 'Your next idea starts here'),
    h('h1', {}, 'What are we building?'), h('p', {}, 'Pick your agents below. Give them one goal or a task each — they’ll work together in this folder.'),
    h('div', { class: 'starter-grid' },
      starter('Build something', 'Turn an idea into working code', 'code', 'Help me build '),
      starter('Explore this project', 'Understand the code and structure', 'search', 'Explore this project and explain its structure and how to run it.'))));
  drawTargets(); drawApprovals(); agentStatus.render(chat);
}
const span = (min) => (min >= 10080 ? 'week' : min >= 60 ? `${Math.round(min / 60)} h` : `${min} min`);

// ---- composer ----
function drawTargets() {
  const r = ready();
  if (![...picked].some((id) => r.some((a) => a.id === id)) && r[0]) picked = new Set([r[0].id]);
  $('targets').replaceChildren(...r.map((a) => h('button', { type: 'button', class: 'chip', c: a.color, 'aria-pressed': String(picked.has(a.id)), onclick: () => { picked.has(a.id) ? picked.delete(a.id) : picked.add(a.id); localStorage.picked = JSON.stringify([...picked]); drawTargets(); } }, dot(a.id), a.name, a.limitedUntil ? h('span', { class: 'lim' }, 'limit') : h('span', { class: remainingPercent(a.usage) !== null && remainingPercent(a.usage) <= 20 ? 'lim' : 'pct', title: quotaTooltip(a), 'aria-label': `${a.name}: ${remainingPercent(a.usage) === null ? 'remaining quota unavailable' : `${remainingPercent(a.usage)}% remaining`}` }, remainingPercent(a.usage) === null ? '—' : `${remainingPercent(a.usage)}% left`))), ...(r.length ? [] : [h('button', { type: 'button', onclick: () => prefs.open('agents') }, 'Set up an agent')]));
  $('models').replaceChildren(...r.filter((a) => picked.has(a.id) && a.models.length).map((a) => h('span', { class: 'mset' }, r.filter((x) => picked.has(x.id)).length > 1 ? h('span', { class: 'dim' }, a.name) : null, ...pickers(a))));
}

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
  const list = m ? ready().filter((a) => [a.handle, a.id, a.name.toLowerCase(), ...a.aliases].some((n) => n.startsWith(m[2].toLowerCase()))) : [];
  if (m && ready().length > 1 && 'all'.startsWith(m[2].toLowerCase())) list.push({ id: 'all', handle: 'all', name: 'All', color: '#888' });
  $('mentions').hidden = !list.length;
  mIdx = Math.min(mIdx, Math.max(0, list.length - 1));
  $('mentions').replaceChildren(...list.map((a, k) => h('button', { type: 'button', class: k === mIdx ? 'on' : '', onmousedown: (e) => { e.preventDefault(); pick(a.handle, m); } }, h('span', { class: 'dot', c: a.color }), a.name, h('span', { class: 'dim' }, `@${a.handle}`))));
  return { list, m };
}
function pick(handle, m) { const i = $('input'), s = i.selectionStart; i.setRangeText(`@${handle} `, s - m[2].length - 1, s, 'end'); mIdx = 0; mentions(); }
$('input').addEventListener('input', () => { fit(); mentions(); });
$('input').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (!$('mentions').hidden) {
    const { list, m } = mentions();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mIdx = (mIdx + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length; mentions(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(list[mIdx].handle, m); return; }
    if (e.key === 'Escape') { $('mentions').hidden = true; return; }
  }
  if (e.key === 'Enter' && (settings.sendKey === 'mod' ? e.metaKey || e.ctrlKey : !e.shiftKey)) { e.preventDefault(); send().catch(() => {}); }
});
$('composer').onsubmit = (e) => { e.preventDefault(); send().catch(() => {}); };
$('stop').onclick = () => go('stop', chat.id);
$('mode').onchange = async (e) => { try { const c = await call('chat:update', chat.id, { mode: e.target.value }); chat.mode = c.mode; if (c.mode === 'full') toast('Full access: agents can run any command and use any site without asking.'); } catch {} };
$('title').onchange = async (e) => { const id = chat.id, before = chat.title; try { const c = await call('chat:update', id, { title: e.target.value }); if (chat?.id === id) { chat.title = c.title; e.target.value = c.title; } } catch { if (chat?.id === id) e.target.value = before; } };
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
  const on = !$('web').hidden && !prefs.isOpen && !sidebarModal && tabs.active;
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
  if (ch === 'agents') { agents = d; if (chat) { drawTargets(); agentStatus.render(chat); } else drawChat(); prefs.refresh(); drawWeb(); }
  if (ch === 'chats') { chats = d; const c = chats.find((x) => x.id === chat?.id); if (c) { Object.assign(chat, { title: c.title, pinned: c.pinned, archived: c.archived, group: c.group }); if (document.activeElement !== $('title')) $('title').value = c.title; } drawChats(); }
  if (ch === 'message' && d.chatId === chat?.id) {
    const i = chat.messages.findIndex((m) => m.id === d.message.id);
    if (i < 0) chat.messages.push(d.message); else chat.messages[i] = d.message;
    // Each agent keeps its own box; nothing scrolls under the user.
    if (!$('log').contains(lanesRoot)) { lanes.render(chat); $('log').replaceChildren(lanesRoot); } else lanes.update(d.message);
    agentStatus.render(chat);
  }
  if (ch === 'usage') { const a = agents.find((x) => x.id === d.agentId); if (a) { a.usage = d.usage; a.usageDetails = d.usageDetails || d.usage; a.usageUpdatedAt = d.usageUpdatedAt; if (chat) drawTargets(); prefs.refresh(); } }
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
