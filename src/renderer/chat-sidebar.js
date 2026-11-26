import { organizeChats } from '../shared/chats.js';
const PATHS = {
  search: ['M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0', 'm15 15 6 6'],
  pin: ['m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6Z', 'M12 15v6'],
  archive: ['M4 8h16v12H4z', 'M3 4h18v4H3z', 'M10 12h4'],
  folder: ['M3 6h7l2 2h9v12H3z'],
  rename: ['m15 4 5 5-10 10-6 1 1-6L15 4Z', 'm13 6 5 5'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'm6 7 1 14h10l1-14', 'M10 11v6', 'M14 11v6'],
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[name] || []) { const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}
export function createChatSidebar({ root, h, nice, onOpen, onUpdate, onDelete, onModal = () => {} }) {
  let chats = [], activeId, query = '', archived = false, menu, opener, menuChat, dialog, modalChat;
  const collapsed = new Set();
  try { for (const id of JSON.parse(localStorage.getItem('copycli.collapsedChats') || '[]')) collapsed.add(id); } catch {}
  const list = h('div', { class: 'cb-list' });
  const error = h('div', { class: 'cb-error', role: 'status', hidden: true });
  const search = h('input', { type: 'search', class: 'cb-search', placeholder: 'Search chats', 'aria-label': 'Search conversations', 'aria-keyshortcuts': 'Meta+K Control+K', oninput: (e) => { query = e.target.value; draw(); } });
  const activeTab = h('button', { type: 'button', onclick: () => filter(false) }, 'Chats');
  const archivedTab = h('button', { type: 'button', onclick: () => filter(true) }, 'Archived');
  root.classList.add('chat-sidebar');
  root.replaceChildren(h('div', { class: 'cb-controls' }, h('label', { class: 'cb-search-wrap' }, icon('search'), search, h('kbd', { 'aria-hidden': 'true' }, navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K')), h('div', { class: 'cb-filters', role: 'group', 'aria-label': 'Conversation view' }, activeTab, archivedTab)), error, list);
  const fail = (e) => { error.textContent = e?.message || 'Could not update the conversation.'; error.hidden = false; };
  function filter(value) { archived = value; closeMenu(); draw(); }
  async function update(id, patch) {
    const result = await onUpdate(id, patch);
    // IPC broadcasts may arrive before or after the return value.
    chats = chats.map((c) => c.id === id ? { ...c, ...patch, ...(result || {}) } : c);
    error.hidden = true; draw();
    return result;
  }
  function closeMenu(focus = true) {
    const target = opener?.isConnected ? opener : menuChat ? root.querySelector(`[data-chat-id="${CSS.escape(menuChat)}"] .cb-more`) : null;
    menu?.remove(); menu = null; menuChat = null;
    if (target) { opener = target; }
    if (opener?.isConnected) { opener.setAttribute('aria-expanded', 'false'); if (focus) opener.focus(); }
    opener = null;
  }
  function openMenu(c, button) {
    if (menuChat === c.id) return closeMenu();
    closeMenu(false); opener = button; menuChat = c.id;
    button.setAttribute('aria-expanded', 'true');
    const item = (label, glyph, action, bad = false) => h('button', { class: `cb-menu-item${bad ? ' bad' : ''}`, type: 'button', role: 'menuitem', onclick: () => { closeMenu(false); Promise.resolve().then(action).catch(fail); } }, icon(glyph), label);
    menu = h('div', { class: 'cb-menu', role: 'menu', 'aria-label': `Actions for ${c.title}` },
      item('Rename', 'rename', () => edit(c, 'title')),
      item(c.pinned ? 'Unpin' : 'Pin to top', 'pin', () => update(c.id, { pinned: !c.pinned })),
      item('Move to group…', 'folder', () => edit(c, 'group')),
      c.group ? item('Remove from group', 'folder', () => update(c.id, { group: '' })) : null,
      item(c.archived ? 'Restore chat' : 'Archive chat', 'archive', () => c.running && !c.archived ? confirmArchive(c) : update(c.id, { archived: !c.archived })),
      h('div', { class: 'cb-menu-divider', role: 'separator' }),
      item('Delete chat…', 'trash', async () => { if (await onDelete(c.id)) { chats = chats.filter((x) => x.id !== c.id); draw(); } }, true));
    document.body.append(menu);
    const r = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(r.bottom + 5, innerHeight - menu.offsetHeight - 8))}px`;
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('[role=menuitem]')], i = items.indexOf(document.activeElement);
      if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); closeMenu(); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length].focus(); }
    });
    menu.querySelector('button').focus();
  }
  function showDialog(c, title, description, content, submitLabel, onSubmit) {
    closeMenu(false);
    dialog?.close(); dialog?.remove();
    modalChat = c.id;
    const err = h('p', { class: 'cb-dialog-error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'primary', type: 'submit' }, submitLabel);
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault(); submit.disabled = true; err.hidden = true;
      try { await onSubmit(); d.close(); } catch (ex) { err.textContent = ex.message; err.hidden = false; submit.disabled = false; }
    } }, h('h2', { id: 'cb-dialog-title' }, title), h('p', { id: 'cb-dialog-desc' }, description), content, err, h('div', { class: 'cb-dialog-actions' }, h('button', { type: 'button', class: 'quiet', onclick: () => d.close() }, 'Cancel'), submit));
    const d = h('dialog', { class: 'cb-dialog', 'aria-labelledby': 'cb-dialog-title', 'aria-describedby': 'cb-dialog-desc' }, form);
    dialog = d; document.body.append(d);
    d.addEventListener('close', () => { d.remove(); if (dialog === d) { dialog = null; modalChat = null; onModal(false); } root.querySelector(`[data-chat-id="${CSS.escape(c.id)}"] .cb-more`)?.focus(); });
    onModal(true); d.showModal();
    d.querySelector('input')?.select();
  }
  function edit(c, field) {
    const rename = field === 'title';
    const input = h('input', { class: 'cb-field', type: 'text', required: rename, maxLength: rename ? 80 : 60, value: rename ? c.title : c.group || '', placeholder: rename ? 'Conversation name' : 'e.g. University', 'aria-label': rename ? 'Conversation name' : 'Group name', ...(rename ? {} : { list: 'cb-existing-groups' }) });
    const groups = h('datalist', { id: 'cb-existing-groups' }, [...new Set(chats.map((x) => x.group).filter(Boolean))].sort().map((name) => h('option', { value: name })));
    showDialog(c, rename ? 'Rename conversation' : 'Move to group', rename ? 'Give this chat a name you can find later.' : 'Choose an existing group or create one. Leave empty to remove the group.', h('div', {}, h('label', { class: 'cb-field-label' }, rename ? 'Name' : 'Group', input), rename ? null : groups), rename ? 'Save name' : 'Move chat', async () => {
      const value = input.value.trim();
      if (rename && !value) throw new Error('Give the conversation a name.');
      await update(c.id, { [field]: value });
    });
  }
  function confirmArchive(c) {
    showDialog(c, 'Archive this conversation?', 'Agents are still working. Archiving hides the chat from the main list and their work will continue.', null, 'Archive chat', () => update(c.id, { archived: true }));
  }
  function row(c) {
    const more = h('button', { class: 'cb-more', type: 'button', title: `Actions for ${c.title}`, 'aria-label': `Actions for ${c.title}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => openMenu(c, more) }, '⋯');
    const open = h('button', { class: 'open', title: `${c.title}\n${nice(c.cwd)}`, 'aria-current': activeId === c.id ? 'page' : undefined, onclick: () => onOpen(c.id) }, h('div', { class: 't' }, c.title), h('div', { class: 'f' }, nice(c.cwd)));
    const r = h('div', { class: `chat${activeId === c.id ? ' on' : ''}`, 'data-chat-id': c.id, oncontextmenu: (e) => { e.preventDefault(); openMenu(c, more); }, onkeydown: (e) => { if (e.key === 'F2') { e.preventDefault(); edit(c, 'title'); } } }, open, c.running ? h('span', { class: 'dot live', title: 'Agents working', 'aria-label': 'Agents working' }) : null, more);
    return r;
  }
  function draw() {
    const archivedCount = chats.filter((c) => c.archived).length;
    activeTab.setAttribute('aria-pressed', String(!archived)); archivedTab.setAttribute('aria-pressed', String(archived));
    archivedTab.textContent = `Archived${archivedCount ? ` ${archivedCount}` : ''}`;
    const sections = organizeChats(chats, { query, archived });
    list.replaceChildren(...sections.map((section) => {
      const closed = !query && collapsed.has(section.id);
      const heading = h('button', { class: 'cb-section-heading', 'data-section': section.id, type: 'button', 'aria-expanded': String(!closed), onclick: () => { collapsed.has(section.id) ? collapsed.delete(section.id) : collapsed.add(section.id); try { localStorage.setItem('copycli.collapsedChats', JSON.stringify([...collapsed])); } catch {} draw(); list.querySelector(`[data-section="${CSS.escape(section.id)}"]`)?.focus(); } }, h('span', { class: 'cb-chevron', 'aria-hidden': 'true' }, closed ? '›' : '⌄'), section.kind === 'pinned' ? icon('pin') : null, h('span', { class: 'cb-section-name' }, section.label), h('span', { class: 'cb-section-count' }, section.chats.length));
      return h('section', { class: 'cb-section' }, heading, h('div', { hidden: closed }, section.chats.map(row)));
    }));
    if (!sections.length) list.append(h('p', { class: 'cb-empty' }, query ? 'No matching conversations.' : archived ? 'Archived chats will appear here.' : 'Your conversations will appear here.'));
  }
  document.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target) && !opener?.contains(e.target)) closeMenu(false); });
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !root.closest('[inert]') && !dialog) { e.preventDefault(); search.focus(); search.select(); } });
  root.addEventListener('scroll', () => closeMenu(false), true);
  return { render(next, id) {
    const switched = id && id !== activeId;
    chats = next; activeId = id;
    if (switched) {
      const current = chats.find((c) => c.id === id);
      archived = !!current?.archived;
      if (!current || !organizeChats([current], { query, archived }).length) { query = ''; search.value = ''; }
      collapsed.delete(current?.pinned && !archived ? 'pinned' : current?.group ? `group:${current.group}` : 'recent');
    }
    if (menuChat && !chats.some((c) => c.id === menuChat)) closeMenu(false);
    if (modalChat && !chats.some((c) => c.id === modalChat)) dialog?.close();
    draw();
    const count = document.getElementById('chat-count'); if (count) count.textContent = chats.filter((c) => !c.archived).length || '';
  } };
}
