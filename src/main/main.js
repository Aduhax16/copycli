import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification, nativeTheme, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Orchestrator, TOOLS } from './orchestrator.js';
import { McpServer } from './mcp.js';
import { Browser } from './browser.js';
import { forgetEnv } from './env.js';
import { detect } from './agents/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = !app.isPackaged && process.argv.includes('--smoke');
if (SMOKE) app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), 'copycli-smoke-')));
app.setName('CopyCLI');
// Agents keep using the browser while the window is behind others.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();

let win, store, orch, browser, mcp, quotaTimer;
const emit = (ch, data) => {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('event', { ch, data });
  if (ch === 'question') notify(`${orch.name(data.agentId)} has a question`, data.question, data.chatId);
  if (ch === 'approval') notify(`${orch.name(data.agentId)} needs your approval`, data.title, data.chatId);
  if (ch === 'turn-end') notify(`${orch.name(data.agentId)} ${{ done: 'finished', limit: 'ran out of usage', paused: 'was paused' }[data.status] || 'stopped'}`, orch.chat(data.chatId).title, data.chatId);
};
const notes = new Set(); // kept so clicks still work
function notify(title, body, chatId) {
  if (SMOKE || !store.settings.notify || win.isFocused() || !Notification.isSupported()) return;
  const n = new Notification({ title, body });
  notes.add(n);
  n.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); emit('open-chat', chatId); } });
  n.on('close', () => notes.delete(n));
  n.show();
}

// Agents that only take stdio MCP servers run this with Electron as Node.
const bridge = { command: process.execPath, args: [path.join(here, 'mcp-bridge.cjs').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)], env: { ELECTRON_RUN_AS_NODE: '1' } };
const AGY_CONFIG = path.join(app.getPath('home'), '.gemini/config/mcp_config.json');
const readAgy = () => { try { const t = fs.readFileSync(AGY_CONFIG, 'utf8'); return t.trim() ? JSON.parse(t) : {}; } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error('Antigravity\'s MCP config could not be read, so it was left alone.'); } };

// Opens a Terminal window running one command the user just pressed a button for.
function inTerminal(command) {
  if (process.platform !== 'darwin') throw new Error(`Run this in a terminal: ${command}`);
  const f = path.join(app.getPath('temp'), `copycli-${randomUUID()}.command`);
  fs.writeFileSync(f, `#!/bin/zsh -il\nrm -f "$0"\necho ${q(`$ ${command}`)}\n${command}\necho\necho "Done. You can close this window and press Refresh in CopyCLI."\n`, { mode: 0o700 });
  return shell.openPath(f);
}
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// After a button opened Terminal, notice by ourselves when the agent is ready.
const watching = new Map();
function watchAgent(id) {
  clearInterval(watching.get(id));
  const before = orch.status.get(id), end = Date.now() + 10 * 60e3;
  const timer = setInterval(async () => {
    const d = orch.def(id), s = d && await detect(d).catch(() => null);
    const done = s?.installed && (!before?.installed ? s.signedIn !== false : before.signedIn === false && s.signedIn === true);
    if (!done && d && Date.now() < end) return;
    clearInterval(timer);
    watching.delete(id);
    if (done) { forgetEnv(); orch.refreshAgents(); }
  }, 4000);
  watching.set(id, timer);
}

const api = {
  init: async () => { const agents = orch.agents(); orch.refreshAgents(); return { agents, chats: orch.listChats(), settings: store.settings, browser: browser.state(), version: app.getVersion(), home: app.getPath('home') }; },
  'chat:open': (id) => ({ chat: orch.chat(id), approvals: orch.pendingApprovals(id) }),
  'chat:new': async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], message: 'Choose the folder your agents will work in' }); return r.canceled ? null : orch.createChat({ cwd: r.filePaths[0] }); },
  'chat:update': (id, p) => orch.updateChat(id, { title: p?.title, mode: p?.mode, pinned: p?.pinned, archived: p?.archived, group: p?.group }),
  'chat:folder': async (id) => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : orch.updateChat(id, { cwd: r.filePaths[0] }); },
  'chat:delete': async (id) => { const r = await dialog.showMessageBox(win, { type: 'warning', message: 'Delete this chat?', detail: 'The chat is removed from CopyCLI. Files in the folder are not touched.', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1 }); if (r.response) return false; orch.deleteChat(id); return true; },
  send: (id, text, agents) => orch.send(id, String(text), agents),
  stop: (id, agent) => orch.stop(id, agent),
  continue: (id, msg, agent) => orch.continueWith(id, msg, agent),
  approve: (id, d) => orch.resolveApproval(id, d),
  answer: (chat, msg, text) => orch.answer(chat, msg, text),
  'agents:refresh': () => { forgetEnv(); return orch.refreshAgents(); },
  'agents:set': (id, p) => {
    const s = store.settings;
    if (typeof p.enabled === 'boolean') s.disabled = p.enabled ? s.disabled.filter((x) => x !== id) : [...new Set([...s.disabled, id])];
    if (typeof p.model === 'string') { if (p.model.trim() && !p.model.trim().startsWith('-')) s.models[id] = p.model.trim(); else delete s.models[id]; }
    if (typeof p.effort === 'string') { if (/^[a-z]*$/.test(p.effort)) s.efforts[id] = p.effort; }
    if (p.move) { const o = orch.agents().map((a) => a.id), i = o.indexOf(id), j = i + (p.move < 0 ? -1 : 1); if (o[j]) { [o[i], o[j]] = [o[j], o[i]]; s.order = o; } }
    store.saveSettings();
    emit('agents', orch.agents());
  },
  // Install if needed, then sign in, in one Terminal window.
  'agents:connect': (id) => {
    const d = orch.def(id), s = orch.status.get(id);
    if (!d?.login || (!s?.path && !d.install)) return api['agents:install'](id);
    watchAgent(id);
    const bin = s?.path ? q(s.path) : d.bin ? `"$HOME/${d.bin}"` : d.bins[0];
    return inTerminal(`${s?.path ? '' : `${d.install} && `}${[bin, ...d.login].join(' ')}`);
  },
  'agents:install': (id) => { const d = orch.def(id); return d?.install ? inTerminal(d.install) : d?.site && shell.openExternal(d.site); },
  'agents:login': (id) => { const d = orch.def(id), s = orch.status.get(id); if (d?.login && s?.path) watchAgent(id);
    if (d?.login && s?.path) return inTerminal([q(s.path), ...d.login].join(' ')); },
  'agents:add': ({ name, command }) => {
    const [cmd, ...args] = String(command).trim().split(/\s+/), id = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!id || !cmd) throw new Error('Give a name and a command');
    if (orch.def(id)) throw new Error('An agent with that name already exists');
    store.settings.custom.push({ id, name: String(name).trim(), command: cmd, args });
    store.saveSettings();
    return orch.refreshAgents();
  },
  'agents:remove': (id) => { store.settings.custom = store.settings.custom.filter((c) => c.id !== id); store.saveSettings(); orch.dropDrivers(id); orch.status.delete(id); emit('agents', orch.agents()); },
  'agy:tools': async (set) => {
    const c = readAgy();
    if (set === undefined) return !!c.mcpServers?.copycli;
    c.mcpServers ||= {};
    if (set) c.mcpServers.copycli = { command: bridge.command, args: bridge.args, env: bridge.env }; else delete c.mcpServers.copycli;
    fs.mkdirSync(path.dirname(AGY_CONFIG), { recursive: true });
    if (fs.existsSync(AGY_CONFIG)) fs.copyFileSync(AGY_CONFIG, `${AGY_CONFIG}.copycli-backup`);
    fs.writeFileSync(AGY_CONFIG, JSON.stringify(c, null, 2));
    return !!set;
  },
  'settings:set': (p) => {
    const s = store.settings;
    if (typeof p.autoHandoff === 'boolean') s.autoHandoff = p.autoHandoff;
    if (typeof p.leanCodex === 'boolean') { s.leanCodex = p.leanCodex; orch.dropDrivers('codex'); }
    if (['system', 'light', 'dark'].includes(p.theme)) { s.theme = p.theme; nativeTheme.themeSource = p.theme; }
    if (['enter', 'mod'].includes(p.sendKey)) s.sendKey = p.sendKey;
    if (['plan', 'ask', 'edit', 'full'].includes(p.defaultMode)) s.defaultMode = p.defaultMode;
    if (typeof p.notify === 'boolean') s.notify = p.notify;
    if (typeof p.autoBrowser === 'boolean') s.autoBrowser = p.autoBrowser;
    if (typeof p.instructions === 'string' && p.instructions.slice(0, 4000) !== s.instructions) { s.instructions = p.instructions.slice(0, 4000); orch.dropDrivers('codex'); }
    const g = p.guard || {};
    if (typeof g.on === 'boolean') s.guard.on = g.on;
    for (const [k, lo, hi] of [['perTask', 1, 100], ['reserve', 0, 90], ['actions', 5, 500]]) if (Number.isFinite(g[k])) s.guard[k] = Math.min(hi, Math.max(lo, Math.round(g[k])));
    store.saveSettings();
    return s;
  },
  'browser:new': () => { const t = browser.create(null); return t.id; },
  'browser:go': (id, u) => browser.go(id, u),
  'browser:nav': (id, w) => browser.nav(id, w),
  'browser:select': (id) => browser.select(id),
  'browser:close': (id) => browser.close(id),
  'browser:bounds': (b) => browser.setBounds(b),
  'browser:clear': async () => {
    const r = await dialog.showMessageBox(win, { type: 'warning', message: 'Clear browsing data?', detail: 'You will be signed out of every site in CopyCLI\'s browser.', buttons: ['Clear', 'Cancel'], defaultId: 1, cancelId: 1 });
    if (r.response) return false;
    await Promise.all([browser.ses.clearStorageData(), browser.ses.clearCache(), browser.ses.clearAuthCache()]);
    emit('browser:notice', 'Browsing data cleared.');
    return true;
  },
  'sites:list': () => orch.sites(),
  'sites:remove': (chat, host) => orch.removeSite(chat, host),
  'data:open': () => shell.openPath(app.getPath('userData')),
  'browser:share': (tab, chat, agent) => orch.shareTab(tab, chat, agent),
  reveal: (id) => shell.openPath(orch.chat(id).cwd),
  external: (u) => { if (/^https?:\/\//i.test(u)) return shell.openExternal(u); },
};
for (const [ch, fn] of Object.entries(api)) ipcMain.handle(ch, async (e, ...a) => {
  if (!win || e.senderFrame !== win.webContents.mainFrame) throw new Error('Refused');
  try { return { ok: await fn(...a) }; } catch (err) { return { error: err.message }; }
});

function menu() {
  const mac = process.platform === 'darwin', prefs = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => emit('menu', 'settings') };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, prefs, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [{ label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => emit('menu', 'new') }, ...(mac ? [] : [prefs]), { type: 'separator' }, { role: 'close' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Toggle Browser', accelerator: 'CmdOrCtrl+B', click: () => emit('menu', 'browser') }, { label: 'Stop Agents', accelerator: 'CmdOrCtrl+.', click: () => emit('menu', 'stop') }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Check for Updates', click: () => shell.openExternal('https://github.com/Aduhax16/copycli/releases') }, { label: 'Source on GitHub', click: () => shell.openExternal('https://github.com/Aduhax16/copycli') }] },
  ]));
}

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));
  orch = new Orchestrator({ store, emit, version: app.getVersion(), bridge });
  mcp = new McpServer({ tools: TOOLS, call: (w, n, a) => orch.callTool(w, n, a), version: app.getVersion() });
  await mcp.listen();
  orch.mcp = mcp;
  session.defaultSession.setPermissionRequestHandler((_w, p, cb) => cb(p === 'clipboard-sanitized-write'));
  menu();
  nativeTheme.themeSource = ['light', 'dark'].includes(store.settings.theme) ? store.settings.theme : 'system';
  win = new BrowserWindow({ width: 1440, height: 900, minWidth: 860, minHeight: 560, show: !SMOKE, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 17 }, backgroundColor: '#1b1c1e', webPreferences: { preload: path.join(here, '../preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browser = new Browser(win, emit, (u) => { try { const x = new URL(u); return x.port === String(mcp.port) && /^(127\.|localhost$|\[|0\.0\.0\.0)/.test(x.hostname) || !/^(https?|wss?|data|blob|about|devtools):$/.test(x.protocol); } catch { return true; } });
  orch.browser = browser;
  win.on('closed', () => { win = null; app.quit(); });
  await win.loadFile(path.join(here, '../renderer/index.html'));
  if (!SMOKE) quotaTimer = setInterval(() => orch.refreshUsage(), 120000);
  if (SMOKE) { win.showInactive(); const { smoke } = await import('../../test/smoke.js'); await smoke({ win, orch, browser, store, mcp }); }
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { clearInterval(quotaTimer); orch?.shutdown(); });
app.on('window-all-closed', () => app.quit());
