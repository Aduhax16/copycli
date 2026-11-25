import { markdown } from './markdown.js';
const $ = (id) => document.getElementById(id);
const h = (tag, props = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (v === undefined || v === null || v === false) continue; if (k.startsWith('on')) e[k] = v; else if (k === 'class') e.className = v; else if (k === 'c') e.style.setProperty('--c', v); else if (k in e && k !== 'list') e[k] = v; else e.setAttribute(k, v); } e.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false)); return e; };
let agents = [], chats = [], chat = null, approvals = [], tabs = { tabs: [], active: null }, settings = {}, home = '';
let picked = new Set(JSON.parse(localStorage.picked || '[]'));
let toastTimer;
const toast = (t) => { $('toast').textContent = t; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); };
const call = (...a) => window.deck.call(...a).catch((e) => { toast(e.message); throw e; });
const go = (...a) => { call(...a).catch(() => {}); };
const agent = (id) => agents.find((a) => a.id === id) || { id, name: id, color: '#888' };
const ready = () => agents.filter((a) => a.installed && a.enabled && a.signedIn !== false);
const dot = (id, live) => h('span', { class: `dot${live ? ' live' : ''}`, c: agent(id).color });
const nice = (p) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);

// ---- sidebar ----
function drawChats() {
  $('chats').replaceChildren(...chats.map((c) => h('div', { class: `chat${chat?.id === c.id ? ' on' : ''}` },
    h('button', { class: 'open', onclick: () => open(c.id) }, h('div', { class: 't' }, c.title), h('div', { class: 'f' }, nice(c.cwd))),
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
  for (const x of ['title', 'folder', 'composer']) $(x).hidden = !chat;
  if (!chat) {
    const n = ready();
    $('log').replaceChildren(h('div', { class: 'empty' }, h('h1', {}, 'Relaydeck'), h('p', {}, n.length ? `Ready: ${n.map((a) => a.name).join(', ')}.` : 'No agent is ready yet. Open Agents to install one or sign in.'), h('button', { class: 'primary', onclick: newChat }, 'Choose a folder to start')));
    drawApprovals();
    return;
  }
  $('title').value = chat.title; $('folder').textContent = nice(chat.cwd); $('mode').value = chat.mode;
  $('log').replaceChildren();
  chat.messages.forEach(place);
  if (!chat.messages.length) $('log').append(h('div', { class: 'empty' }, h('p', {}, 'Pick one agent or several. They share this chat and this folder, and each one sees what the others did.')));
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
const STATE = { running: 'Working', limit: 'Out of usage', error: 'Stopped', cancelled: 'Stopped by you' };
function agentCard(m, keep = new Set()) {
  const a = agent(m.agentId), live = m.status === 'running';
  const others = ready().filter((x) => x.id !== m.agentId);
  const body = h('div', { class: 'body' });
  for (const p of m.parts) {
    if (p.type === 'text') body.append(markdown(p.text));
    else {
      const d = h('details', { class: 'tool', open: keep.has(p.id) }, h('summary', {}, h('span', { class: `mark ${p.status}` }, p.status === 'done' ? '✓' : p.status === 'error' ? '✕' : '…'), h('b', {}, p.name.replace(/^mcp__relaydeck__/, '')), p.detail ? h('code', {}, p.detail.split('\n')[0]) : null));
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
    h('header', {}, dot(m.agentId, live), a.name, h('span', { class: `state ${m.status}` }, m.note ? 'Note to the team' : STATE[m.status] || ''), h('span', { class: 'grow' }), live ? h('button', { class: 'quiet', onclick: () => go('stop', chat.id, m.agentId) }, 'Stop') : !m.note && others.length && m.status !== 'done' ? more : null),
    body, m.files?.length ? h('div', { class: 'files' }, `Changed ${m.files.join(', ')}`) : null);
}

// ---- composer ----
function drawTargets() {
  const r = ready();
  if (![...picked].some((id) => r.some((a) => a.id === id)) && r[0]) picked = new Set([r[0].id]);
  $('targets').replaceChildren(...r.map((a) => h('button', { type: 'button', class: 'chip', c: a.color, 'aria-pressed': String(picked.has(a.id)), onclick: () => { picked.has(a.id) ? picked.delete(a.id) : picked.add(a.id); localStorage.picked = JSON.stringify([...picked]); drawTargets(); } }, dot(a.id), a.name, a.limitedUntil ? h('span', { class: 'lim' }, 'limit') : null)), ...(r.length ? [] : [h('button', { type: 'button', onclick: showAgents }, 'Set up an agent')]));
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
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send().catch(() => {}); }
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

// ---- agents ----
async function showAgents() {
  const d = $('agents-dlg'), agy = await window.deck.call('agy:tools').catch(() => false);
  const row = (a, i, n) => h('div', { class: 'a' }, h('span', { class: 'dot', c: a.color }), h('div', { class: 'nm' }, a.name, h('div', { class: 's' }, !a.installed ? 'Not installed' : a.signedIn === false ? 'Not signed in' : a.limitedUntil ? `Out of usage until ${new Date(a.limitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : a.signedIn ? 'Ready' : 'Installed')),
    !a.installed ? (a.install || a.site ? h('button', { title: a.install || a.site, onclick: () => go('agents:install', a.id) }, a.install ? 'Install' : 'Get it') : null) : [
      h('input', { type: 'text', placeholder: 'Default model', value: a.model, 'aria-label': `${a.name} model`, onchange: (e) => go('agents:set', a.id, { model: e.target.value }) , hidden: a.kind === 'acp' }),
      a.canLogin ? h('button', { onclick: () => go('agents:login', a.id) }, 'Sign in') : null,
      h('label', {}, h('input', { type: 'checkbox', checked: a.enabled, onchange: (e) => go('agents:set', a.id, { enabled: e.target.checked }) }), ' On')],
    a.custom ? h('button', { class: 'quiet', onclick: () => go('agents:remove', a.id) }, 'Remove') : null,
    a.installed ? [h('button', { class: 'ord', disabled: !i, 'aria-label': `Move ${a.name} up`, onclick: () => go('agents:set', a.id, { move: -1 }) }, '↑'), h('button', { class: 'ord', disabled: i === n - 1, 'aria-label': `Move ${a.name} down`, onclick: () => go('agents:set', a.id, { move: 1 }) }, '↓')] : null);
  const inst = agents.filter((a) => a.installed), rest = agents.filter((a) => !a.installed);
  const nm = h('input', { type: 'text', placeholder: 'Name' }), cmd = h('input', { type: 'text', placeholder: 'Command, e.g. my-agent acp', size: 28 });
  d.replaceChildren(...[h('h2', {}, 'Agents'), h('p', {}, 'Each agent uses its own command-line app and your own sign-in. When one runs out of usage, the next one in this order continues.'),
    ...inst.map((a, i) => row(a, i, inst.length)),
    h('div', { class: 'foot' }, h('label', {}, h('input', { type: 'checkbox', checked: settings.autoHandoff, onchange: (e) => { settings.autoHandoff = e.target.checked; go('settings:set', { autoHandoff: e.target.checked }); } }), ' Hand over automatically when one runs out')),
    inst.some((a) => a.id === 'antigravity') ? h('div', { class: 'foot' }, h('label', { title: 'Adds a "relaydeck" entry to ~/.gemini/config/mcp_config.json' }, h('input', { type: 'checkbox', checked: agy, onchange: (e) => go('agy:tools', e.target.checked) }), ' Give Antigravity the browser and team tools (edits its MCP config)')) : null,
    h('h3', {}, 'More agents'), ...rest.map((a) => row(a)),
    h('h3', {}, 'Add your own (any agent that speaks ACP)'), h('div', { class: 'foot' }, nm, cmd, h('button', { onclick: async () => { await call('agents:add', { name: nm.value, command: cmd.value }).catch(() => {}); } }, 'Add')),
    h('div', { class: 'foot' }, h('button', { onclick: () => go('agents:refresh') }, 'Refresh'), h('span', { class: 'grow' }), h('button', { class: 'primary', onclick: () => d.close() }, 'Done'))].filter(Boolean));
  if (!d.open) { d.showModal(); layout(); }
}
$('agents-dlg').addEventListener('close', () => layout());
$('agents-btn').onclick = showAgents;
$('new').onclick = () => newChat().catch(() => {});

// ---- browser ----
function layout() {
  const on = !$('web').hidden && !$('agents-dlg').open && tabs.active;
  const r = $('view').getBoundingClientRect();
  window.deck.call('browser:bounds', on ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
}
function toggleWeb(show = $('web').hidden, fresh = true) {
  $('web').hidden = $('grip').hidden = !show;
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
  if (ch === 'agents') { agents = d; if (chat) drawTargets(); else drawChat(); if ($('agents-dlg').open) showAgents(); drawWeb(); }
  if (ch === 'chats') { chats = d; const c = chats.find((x) => x.id === chat?.id); if (c && document.activeElement !== $('title')) $('title').value = c.title; drawChats(); }
  if (ch === 'message' && d.chatId === chat?.id) {
    const log = $('log'), atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
    const i = chat.messages.findIndex((m) => m.id === d.message.id);
    if (i < 0) chat.messages.push(d.message); else chat.messages[i] = d.message;
    place(d.message);
    if (atEnd || d.message.role === 'user') log.scrollTop = 1e9;
  }
  if (ch === 'approval') { approvals.push(d); drawApprovals(); if (d.chatId !== chat?.id) toast(`${agent(d.agentId).name} needs your approval in another chat`); }
  if (ch === 'approval-done') { approvals = approvals.filter((a) => a.id !== d.id); drawApprovals(); }
  if (ch === 'browser:state') { tabs = d; drawWeb(); }
  if (ch === 'browser:used' && d.chatId === chat?.id && $('web').hidden && !layout.seen) { layout.seen = true; toggleWeb(true, false); }
  if (ch === 'browser:notice') toast(d);
  if (ch === 'menu') ({ new: () => newChat().catch(() => {}), agents: showAgents, browser: () => toggleWeb(), stop: () => chat && go('stop', chat.id) })[d]();
});
const s = await call('init');
({ agents, chats, settings, home } = s); tabs = s.browser;
drawChats();
if (localStorage.last && chats.some((c) => c.id === localStorage.last)) await open(localStorage.last); else drawChat();
drawWeb();
