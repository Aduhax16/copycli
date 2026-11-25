import fs from 'node:fs';
import path from 'node:path';

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const write = (f, v) => { const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(v), { mode: 0o600 }); fs.renameSync(t, f); };

export class Store {
  constructor(dir) {
    this.dir = path.join(dir, 'chats');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.settingsFile = path.join(dir, 'settings.json');
    this.settings = { autoHandoff: true, order: ['claude', 'codex', 'antigravity'], disabled: [], models: {}, efforts: { codex: 'low' }, modelLists: {}, custom: [], guard: { v: 2, on: false, perTask: 10, reserve: 10, actions: 60 }, leanCodex: true, theme: 'system', sendKey: 'enter', notify: true, instructions: '', defaultMode: 'ask', autoBrowser: true, ...read(this.settingsFile, {}) };
    // 0.2.0 paused every task at 5% without being asked. Undo that unless the numbers were changed.
    const g = this.settings.guard;
    if (!g.v) this.settings.guard = { ...g, v: 2, ...(g.perTask === 5 && g.reserve === 10 ? { on: false, perTask: 10 } : {}) };
    this.chats = new Map();
    this.timers = new Map();
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      const c = read(path.join(this.dir, f));
      if (!c?.id || !Array.isArray(c.messages)) continue;
      for (const m of c.messages) if (m.status === 'running') { m.status = 'cancelled'; for (const p of m.parts || []) if (p.status === 'running') p.status = 'error'; }
      this.chats.set(c.id, c);
    }
  }
  save(chat) {
    if (this.timers.has(chat.id)) return;
    this.timers.set(chat.id, setTimeout(() => this.flush(chat.id), 400));
  }
  flush(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const c = this.chats.get(id);
    if (c) write(path.join(this.dir, `${id}.json`), c);
  }
  flushAll() { for (const id of [...this.timers.keys()]) this.flush(id); }
  remove(id) { clearTimeout(this.timers.get(id)); this.timers.delete(id); this.chats.delete(id); fs.rmSync(path.join(this.dir, `${id}.json`), { force: true }); }
  saveSettings() { write(this.settingsFile, this.settings); }
}
