// Sidebar organization is persisted on each chat; old chat files need no migration.
const clean = (s, max) => s.trim().replace(/\s+/g, ' ').slice(0, max);
export function applyChatUpdate(chat, patch = {}) {
  if (typeof patch.title === 'string') {
    const title = clean(patch.title, 80);
    if (!title) throw new Error('Give the conversation a name.');
    chat.title = title;
    chat.customTitle = true;
  }
  if (typeof patch.pinned === 'boolean') chat.pinned = patch.pinned;
  if (typeof patch.archived === 'boolean') chat.archived = patch.archived;
  if (typeof patch.group === 'string') chat.group = clean(patch.group, 60);
  return chat;
}
export function chatSummary(c, running = false) {
  return { id: c.id, title: c.title, cwd: c.cwd, updated: c.updated, running, pinned: !!c.pinned, archived: !!c.archived, group: typeof c.group === 'string' ? c.group : '' };
}
const searchable = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const recent = (a, b) => (b.updated || 0) - (a.updated || 0) || String(a.id).localeCompare(String(b.id));
export function organizeChats(chats, { query = '', archived = false } = {}) {
  const q = searchable(query.trim());
  const visible = chats.filter((c) => !!c.archived === archived && (!q || searchable(`${c.title}\n${c.cwd}\n${c.group || ''}`).includes(q))).sort(recent);
  const sections = [], pinned = !archived ? visible.filter((c) => c.pinned) : [];
  if (pinned.length) sections.push({ id: 'pinned', label: 'Pinned', kind: 'pinned', chats: pinned });
  const groups = new Map();
  for (const c of visible) {
    if (!archived && c.pinned) continue;
    const group = c.group || '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(c);
  }
  for (const name of [...groups.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b))) sections.push({ id: `group:${name}`, label: name, kind: 'group', chats: groups.get(name) });
  if (groups.has('')) sections.push({ id: 'recent', label: archived ? 'Archived' : 'Recent', kind: 'recent', chats: groups.get('') });
  return sections;
}
