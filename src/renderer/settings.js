import { remainingPercent, quotaName } from '../shared/usage.js';
// The Settings view. It fills the window over the chat; every change is saved as it is made.
const MODES = [
  ['plan', 'Plan only', 'Agents look around and propose. They change nothing.'],
  ['ask', 'Ask first', 'Agents ask before running commands or editing files.'],
  ['edit', 'Edit files freely', 'Agents edit files in the folder. They ask before riskier steps.'],
  ['full', 'Full access', 'Agents run any command and use any site without asking.'],
];
const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
const KEYS = [['⌘N', 'New chat'], ['⌘,', 'Open settings'], ['⌘B', 'Show or hide the browser'], ['⌘.', 'Stop the agents in this chat'], ['@', 'Mention an agent in a message'], ['Esc', 'Close settings']];
const REPO = 'https://github.com/Aduhax16/copycli';
const I = (d) => `M${d}`;
const ICONS = {
  general: I('4 8h8.5M17.5 8H20M4 16h2.5M11.5 16H20M15 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM9 13.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'),
  agents: I('8 5h8a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3zM9.5 11v1.5M14.5 11v1.5M12 2v3'),
  usage: I('5 19V12M12 19V5M19 19v-9'),
  permissions: I('12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zM9 12l2 2 4-4'),
  browser: I('12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c5 5 5 13 0 18M12 3c-5 5-5 13 0 18'),
  shortcuts: I('5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM7 10h.01M12 10h.01M17 10h.01M8 14h8'),
  about: I('12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01'),
};
const svg = (d) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  p.setAttribute('d', d); s.append(p); return s;
};

export function createSettings({ root, h, call, go, state, save, pickers, onToggle }) {
  let section = 'general', isOpen = false, dirty = false, back = null, drawn = 0;
  const expanded = new Set();
  let draft = { name: '', command: '' };
  const S = () => state().settings;

  // ---- pieces ----
  const row = (title, desc, ...control) => h('div', { class: 'st-row' }, h('div', { class: 'st-label' }, h('div', { class: 'st-name' }, title), desc ? h('div', { class: 'st-desc' }, desc) : null), control.length ? h('div', { class: 'st-control' }, control) : null);
  const card = (...rows) => h('div', { class: 'st-card' }, rows.flat());
  const group = (title, ...kids) => h('section', { class: 'st-group' }, title ? h('h3', {}, title) : null, kids);
  const toggle = (key, label, checked, set) => h('input', { type: 'checkbox', role: 'switch', class: 'st-switch', 'data-k': key, 'aria-label': label, checked, onchange: (e) => set(e.target.checked) });
  const segmented = (key, label, options, value, set) => h('div', { class: 'st-seg', role: 'radiogroup', 'aria-label': label }, options.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-k': `${key}-${v}`, 'aria-checked': String(v === value), onclick: () => set(v) }, t)));
  const button = (label, onclick, props = {}) => h('button', { type: 'button', onclick, ...props }, label);
  const put = async (p) => { await save(p); draw(); };
  const flip = (k) => (v) => put({ [k]: v }).catch(() => draw());
  const number = (k, min, max, unit, label) => h('label', { class: 'st-num' }, h('input', { type: 'number', min, max, 'data-k': `guard-${k}`, 'aria-label': label, value: S().guard[k], disabled: !S().guard.on, onchange: async (e) => { const i = e.target; if (i.value !== '') await save({ guard: { [k]: Number(i.value) } }).catch(() => {}); i.value = S().guard[k]; } }), unit);
  const status = (a) => (!a.installed ? ['Not installed', ''] : !a.enabled ? ['Off', ''] : a.signedIn === false ? ['Not signed in', 'warn'] : a.limitedUntil ? [`Out of usage until ${new Date(a.limitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'warn'] : a.signedIn ? ['Ready', 'good'] : ['Installed', '']);
  const meters = (a) => (a.usageDetails || a.usage).map((u) => h('div', { class: 'st-meter' },
    h('div', { class: 'st-meter-top' }, h('span', {}, quotaName(u)), h('span', {}, `${remainingPercent([u])}% left${u.resetsAt ? ` · resets ${new Date(u.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`)),
    h('div', { class: `st-bar${u.usedPercent >= 95 ? ' bad' : u.usedPercent >= 80 ? ' warn' : ''}`, role: 'meter', 'aria-label': `${a.name} ${quotaName(u)} remaining`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(remainingPercent([u])) }, h('i', { style: `width:${remainingPercent([u])}%` }))));

  // ---- sections ----
  const SECTIONS = {
    general: ['General', 'How CopyCLI looks and behaves.', () => [
      group('Appearance', card(row('Theme', 'Follow your Mac, or always use one.', segmented('theme', 'Theme', THEMES, S().theme, (v) => put({ theme: v }).catch(() => {}))))),
      group('Chat', card(
        row('Send messages with', S().sendKey === 'mod' ? 'Return starts a new line.' : 'Shift Return starts a new line.', segmented('send', 'Send messages with', [['enter', 'Return'], ['mod', '⌘ Return']], S().sendKey, (v) => put({ sendKey: v }).catch(() => {}))),
        row('Notifications', 'When an agent finishes or needs your approval while CopyCLI is in the background.', toggle('notify', 'Notifications', S().notify, flip('notify'))))),
      group('Instructions for every agent', card(h('div', { class: 'st-row st-stack' }, h('div', { class: 'st-desc' }, 'Told to each agent in every chat. Agents that keep a session open pick up changes in a new chat.'),
        h('textarea', { class: 'st-text', rows: 5, maxLength: 4000, 'data-k': 'instructions', 'aria-label': 'Instructions for every agent', placeholder: 'For example: answer in Spanish, keep changes small, run the tests before finishing.', value: S().instructions, onchange: (e) => save({ instructions: e.target.value }).catch(() => {}) })))),
    ]],
    agents: ['Agents', 'Each agent uses its own command-line app and your own sign-in.', (agy) => {
      const { agents } = state(), inst = agents.filter((a) => a.installed), rest = agents.filter((a) => !a.installed);
      const name = h('input', { type: 'text', placeholder: 'Name', 'data-k': 'add-name', 'aria-label': 'Name', value: draft.name, oninput: (e) => { draft.name = e.target.value; } });
      const cmd = h('input', { type: 'text', class: 'grow', placeholder: 'Command, e.g. my-agent acp', 'data-k': 'add-cmd', 'aria-label': 'Command', value: draft.command, oninput: (e) => { draft.command = e.target.value; } });
      return [
        group('Installed', inst.length ? card(inst.map((a, i) => agentRow(a, i, inst.length, agy))) : h('p', { class: 'st-none' }, 'None yet. Install one below.'), inst.length > 1 ? h('p', { class: 'st-hint' }, 'When one runs out of usage, the next in this order continues.') : null),
        rest.length ? group('More agents', card(rest.map((a) => row(h('span', { class: 'st-agent' }, h('span', { class: 'dot', c: a.color }), a.name), a.about || a.install || a.site?.replace('https://', '') || '', a.custom ? button('Remove', () => go('agents:remove', a.id), { class: 'quiet' }) : null, a.install || a.site ? button(a.install ? (a.canLogin ? 'Connect' : 'Install') : 'Get it', () => go('agents:connect', a.id), { title: a.install ? `Runs in Terminal: ${a.install}` : a.site }) : null)))) : null,
        group('Add your own', card(h('form', { class: 'st-row st-add', onsubmit: async (e) => { e.preventDefault(); try { await call('agents:add', { ...draft }); draft = { name: '', command: '' }; draw(); } catch {} } }, name, cmd, h('button', { type: 'submit' }, 'Add'))), h('p', { class: 'st-hint' }, 'Works with any agent that speaks ACP.')),
        h('div', { class: 'st-actions' }, button('Check again', () => go('agents:refresh'), { title: 'Look for installed agents and sign-ins again' })),
      ];
    }],
    usage: ['Usage', 'What is left of your plans, and when to stop spending it.', () => {
      const { agents } = state(), on = agents.filter((a) => a.installed && a.enabled), known = on.filter((a) => (a.usageDetails || a.usage).length), other = on.filter((a) => !(a.usageDetails || a.usage).length);
      return [
        group('Your plans', card(
          known.map((a) => h('div', { class: 'st-row st-stack' }, h('div', { class: 'st-agent st-name' }, h('span', { class: 'dot', c: a.color }), a.name), meters(a), a.usageUpdatedAt ? h('div', { class: 'st-hint' }, `Checked ${new Date(a.usageUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`) : null)),
          other.map((a) => row(a.name, 'The provider has not returned a plan percentage yet.', h('span', { class: 'dim' }, '—')))),
          h('p', { class: 'st-hint' }, 'Percentages show remaining plan quota. The chat shows the tightest limit for the selected model. Refreshed every two minutes and after tasks.')),
        h('div', { class: 'st-actions' }, button('Refresh quotas', () => go('agents:refresh'))),
        group('When an agent runs out', card(row('Hand over automatically', 'The next agent in your order continues the task.', toggle('autoHandoff', 'Hand over automatically', S().autoHandoff, flip('autoHandoff'))))),
        group('Saving usage', card(
          row('Pause agents that use too much', 'Off: you are told, and the agent keeps working.', toggle('guard-on', 'Pause agents that use too much', S().guard.on, (v) => put({ guard: { on: v } }).catch(() => draw()))),
          row('Most one task may use', 'Share of your plan\'s limit.', number('perTask', 1, 100, '%', 'Most one task may use, percent')),
          row('Always keep', 'Agents pause before using this last part.', number('reserve', 0, 90, '%', 'Always keep, percent')),
          row('Actions when the limit is unknown', 'For agents that do not report usage.', number('actions', 5, 500, 'actions', 'Actions when the limit is unknown')))),
      ];
    }],
    permissions: ['Permissions', 'What agents may do without asking you.', (_agy, sites) => [
      group('New chats start in', h('div', { class: 'st-modes', role: 'radiogroup', 'aria-label': 'New chats start in' }, MODES.map(([v, t, d]) => h('button', { type: 'button', role: 'radio', class: `st-mode${v === 'full' ? ' danger' : ''}`, 'data-k': `mode-${v}`, 'aria-checked': String(S().defaultMode === v), onclick: () => put({ defaultMode: v }).catch(() => {}) }, h('span', { class: 'st-name' }, t), h('span', { class: 'st-desc' }, d)))), h('p', { class: 'st-hint' }, 'Chats you already have keep their own setting, under the message box.')),
      group('Sites agents may always use', sites.length ? card(sites.map((s) => row(s.host, s.title, button('Remove', async () => { await call('sites:remove', s.chatId, s.host).catch(() => {}); draw(); }, { 'data-k': `site-${s.chatId}-${s.host}`, 'aria-label': `Remove ${s.host} from ${s.title}` })))) : h('p', { class: 'st-none' }, 'None. Sites you allow with "Always on this site" appear here.')),
    ]],
    browser: ['Browser', 'The browser you and your agents share.', () => [
      group('', card(row('Show the browser when an agent uses it', 'Opens the panel the first time.', toggle('autoBrowser', 'Show the browser when an agent uses it', S().autoBrowser, flip('autoBrowser'))))),
      group('Browsing data', card(row('Clear browsing data', 'Signs you out of every site in this browser and deletes its cookies and cache.', button('Clear…', () => go('browser:clear'), { class: 'bad', 'data-k': 'clear' })))),
    ]],
    shortcuts: ['Shortcuts', 'Keyboard shortcuts.', () => [group('', card(KEYS.map(([k, t]) => row(t, '', h('kbd', {}, k)))))]],
    about: ['About', 'CopyCLI is free and open source.', () => [
      group('', card(
        row('Version', state().version, button('Check for updates', () => go('external', `${REPO}/releases`))),
        row('Source code', 'MIT License', button('Open GitHub', () => go('external', REPO))),
        row('Your data', 'Chats and settings are stored on this Mac.', button('Show in Finder', () => go('data:open'))))),
    ]],
  };
  const agentRow = (a, i, n, agy) => {
    const [text, tone] = status(a), isOpen = expanded.has(a.id), id = `st-agent-${a.id}`;
    const [model, effort] = a.models.length ? pickers(a) : [];
    return h('div', { class: `st-item${a.enabled ? '' : ' off'}` },
      h('div', { class: 'st-row' },
        h('button', { type: 'button', class: 'st-open', 'data-k': `open-${a.id}`, 'aria-expanded': String(isOpen), 'aria-controls': id, onclick: () => { isOpen ? expanded.delete(a.id) : expanded.add(a.id); draw(); } }, h('span', { class: 'st-chev', 'aria-hidden': 'true' }, '›'), h('span', { class: 'dot', c: a.color }), h('span', { class: 'st-name' }, a.name), h('span', { class: `st-status ${tone}` }, text)),
        h('div', { class: 'st-control' },
          a.enabled && a.signedIn === false && a.canLogin ? button('Sign in', () => go('agents:connect', a.id)) : null,
          button('↑', () => go('agents:set', a.id, { move: -1 }), { class: 'quiet st-ord', disabled: !i, 'data-k': `up-${a.id}`, 'aria-label': `Move ${a.name} up` }),
          button('↓', () => go('agents:set', a.id, { move: 1 }), { class: 'quiet st-ord', disabled: i === n - 1, 'data-k': `down-${a.id}`, 'aria-label': `Move ${a.name} down` }),
          toggle(`on-${a.id}`, `Use ${a.name}`, a.enabled, (v) => go('agents:set', a.id, { enabled: v })))),
      isOpen ? h('div', { class: 'st-sub', id },
        row('Model', a.models.length ? '' : a.kind === 'acp' ? 'Models appear after first use.' : '', model || (a.kind === 'acp' ? null : h('input', { type: 'text', placeholder: 'Default model', value: a.model, 'data-k': `model-${a.id}`, 'aria-label': `${a.name} model`, onchange: (e) => go('agents:set', a.id, { model: e.target.value }) }))),
        effort ? row('Effort', 'Less effort uses less of your limit.', effort) : null,
        a.id === 'codex' ? row('Run without its own plugins', 'Uses less, and keeps Codex off your desktop. CopyCLI has its own browser.', toggle('lean', 'Run Codex without its own plugins', S().leanCodex, flip('leanCodex'))) : null,
        a.id === 'antigravity' && agy ? row('Old tools entry', 'CopyCLI no longer needs its "copycli" entry in ~/.gemini/config/mcp_config.json.', button('Remove entry', async () => { await call('agy:tools', false).catch(() => {}); draw(); }, { 'data-k': 'agy' })) : null,
        a.canLogin ? row('Account', a.signedIn === false ? 'Not signed in.' : 'Opens Terminal to sign in or switch account.', button(a.signedIn === false ? 'Sign in' : 'Sign in again', () => go('agents:login', a.id))) : null,
        row('Location', a.path || ''),
        a.custom ? row('Remove this agent', '', button('Remove', () => go('agents:remove', a.id), { class: 'bad' })) : null) : null);
  };

  // ---- drawing ----
  async function draw() {
    if (!isOpen) return;
    const n = ++drawn, want = section;
    const [agy, sites] = await Promise.all([want === 'agents' && state().agents.some((a) => a.id === 'antigravity' && a.installed) ? window.deck.call('agy:tools').catch(() => false) : false, want === 'permissions' ? window.deck.call('sites:list').catch(() => []) : []]);
    if (n !== drawn || !isOpen) return;
    dirty = false;
    const [title, desc, body] = SECTIONS[want], old = root.querySelector('.st-main');
    const at = old?.dataset.section === want ? old.scrollTop : 0, key = root.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    const main = h('div', { class: 'st-main', 'data-section': want }, h('div', { class: 'st-page' }, h('h2', { id: 'st-title' }, title), h('p', { class: 'st-lead' }, desc), body(agy, sites)));
    root.replaceChildren(
      h('aside', { class: 'st-side' }, h('div', { class: 'drag' }), button([h('span', { 'aria-hidden': 'true' }, '←'), ' Back to chat'], close, { class: 'quiet st-back', 'data-k': 'back' }),
        h('nav', { 'aria-label': 'Settings' }, Object.entries(SECTIONS).map(([id, [t]]) => h('button', { type: 'button', class: 'st-nav', 'data-k': `nav-${id}`, 'aria-current': id === want ? 'page' : null, onclick: () => { section = id; draw(); } }, svg(ICONS[id]), t)))),
      h('div', { class: 'st-body' }, h('div', { class: 'drag' }), main));
    main.scrollTop = at;
    if (key) [...root.querySelectorAll('[data-k]')].find((e) => e.dataset.k === key)?.focus();
  }
  // Agents report changes at any time; never redraw under what the user is typing or a menu they have open.
  const busy = () => root.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]), textarea, select');
  function refresh() { if (!isOpen) return; if (busy()) dirty = true; else draw(); }
  root.addEventListener('focusout', () => setTimeout(() => { if (dirty && !busy()) draw(); }, 0));
  root.addEventListener('change', (e) => { if (e.target.matches('select')) setTimeout(() => { e.target.blur(); }, 0); });
  addEventListener('keydown', (e) => { if (isOpen && e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } });

  async function open(id) {
    if (SECTIONS[id]) section = id;
    if (!isOpen) back = document.activeElement;
    isOpen = true; root.hidden = false; onToggle(true);
    await draw();
    root.querySelector('[aria-current=page]')?.focus({ focusVisible: false });
  }
  function close() {
    if (!isOpen) return;
    document.activeElement?.blur?.(); // saves a field being edited
    isOpen = false; root.hidden = true; root.replaceChildren(); onToggle(false);
    back?.focus?.();
  }
  return { open, close, refresh, get isOpen() { return isOpen; } };
}
