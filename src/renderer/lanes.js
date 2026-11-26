// The chat as one box per agent. A box shows that agent's newest turn; arrows step back through earlier ones.
// A box grows with its text, and a new turn replaces the old one in place, so the page does not jump.
const STATE = { running: 'Working', paused: 'Paused', limit: 'Out of usage', error: 'Stopped', cancelled: 'Stopped by you', done: 'Done' };
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0));
const spend = (m) => { const u = m.usage, bits = []; if (u) bits.push(`${tok(u.fresh)} new`, u.cached ? `${tok(u.cached)} reused` : '', `${tok(u.output)} written`, u.calls ? `${u.calls} calls` : ''); if (m.spent) bits.push(`${m.spent}% of limit`); return bits.filter(Boolean).join(' · '); };
const SPEND_HELP = 'Tokens. New: read for the first time. Reused: read again from cache, at a lower cost. Written: the answer, including thinking. Each company counts tokens its own way.';

export function createLanes({ root, h, agent, ready, dot, markdown, go, call, sendKey }) {
  let chat = null;
  const view = new Map();     // agentId -> turn index being looked at; absent = follow the newest
  const drafts = new Map();   // question id -> answer not sent yet
  const opened = new Set();   // tool steps the user expanded
  const full = new Set();     // prompts shown in full
  const lanes = new Map();    // agentId -> element

  const turnsOf = (id) => chat.messages.filter((m) => m.role === 'agent' && !m.note && m.agentId === id);
  // Every agent that took part, in the order it first appeared.
  function ids() {
    const out = [];
    for (const m of chat.messages) for (const id of m.role === 'user' ? m.targets || [] : m.role === 'agent' ? [m.agentId] : []) if (!out.includes(id)) out.push(id);
    return out;
  }
  const between = (m, from, to) => m.ts >= from && m.ts < to;

  function tools(m, p) {
    const key = `${m.id}:${p.id}`;
    const d = h('details', { class: 'tool', open: opened.has(key), ontoggle: (e) => { e.target.open ? opened.add(key) : opened.delete(key); } },
      h('summary', {}, h('span', { class: `mark ${p.status}` }, p.status === 'done' ? '✓' : p.status === 'error' ? '✕' : '…'), h('b', {}, p.name.replace(/^mcp__copycli__/, '')), p.detail ? h('code', {}, p.detail.split('\n')[0]) : null));
    const more = [p.detail?.includes('\n') || p.detail?.length > 80 ? p.detail : '', p.output].filter(Boolean).join('\n\n');
    if (more) d.append(h('pre', {}, more));
    return d;
  }
  function question(t) {
    const q = t.question, a = agent(t.agentId);
    const box = h('section', { class: `lane-q${q.answer ? ' answered' : ''}`, 'aria-label': `${a.name}'s question` },
      h('div', { class: 'lane-q-head' }, h('span', { class: 'lane-q-mark', 'aria-hidden': 'true' }, '?'), q.answer ? 'Question' : `${a.name} is asking you`, q.pauseOthers && !q.answer ? h('span', { class: 'lane-q-hold' }, 'Others wait for your answer') : null),
      h('div', { class: 'lane-q-text' }, markdown(q.text)));
    if (q.answer) { box.append(h('div', { class: 'lane-q-answer' }, h('span', { class: 'dim' }, 'You answered'), h('div', {}, q.answer))); return box; }
    const input = h('textarea', { rows: 2, 'data-q': q.id, 'aria-label': `Answer ${a.name}`, placeholder: `Answer ${a.name}…`, value: drafts.get(q.id) || '',
      oninput: (e) => { drafts.set(q.id, e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; },
      onkeydown: (e) => { if (e.isComposing || e.key !== 'Enter') return; if (sendKey() === 'mod' ? e.metaKey || e.ctrlKey : !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); } } });
    box.append(h('form', { class: 'lane-q-form', onsubmit: async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return input.focus();
      try { await call('answer', chat.id, t.id, text); drafts.delete(q.id); } catch {}
    } }, input, h('button', { type: 'submit', class: 'primary' }, 'Answer')));
    return box;
  }

  function lane(id) {
    const a = agent(id), turns = turnsOf(id), n = turns.length;
    const i = n ? Math.min(view.has(id) ? view.get(id) : n - 1, n - 1) : -1, t = turns[i];
    const from = t ? t.ts : 0, to = turns[i + 1]?.ts ?? Infinity;
    const live = t?.status === 'running', newest = i === n - 1;
    // What the user sent for this turn; before the first turn starts, the message that is waiting.
    const sent = t ? chat.messages.find((m) => m.role === 'user' && m.round === t.round) : [...chat.messages].reverse().find((m) => m.role === 'user' && m.targets?.includes(id));
    const others = ready().filter((x) => x.id !== id);
    const head = h('header', { class: 'lane-head' }, dot(id, live), h('span', { class: 'lane-name' }, a.name),
      h('span', { class: `state ${t?.status || 'running'}` }, t ? STATE[t.status] || '' : 'Starting…'),
      h('span', { class: 'grow' }),
      n > 1 ? h('div', { class: 'lane-nav', role: 'group', 'aria-label': `${a.name}'s turns` },
        h('button', { type: 'button', class: 'quiet', 'data-k': `prev-${id}`, 'aria-label': 'Earlier turn', disabled: i <= 0, onclick: () => { view.set(id, i - 1); draw(id); } }, '‹'),
        h('span', { class: 'lane-count', 'aria-live': 'polite' }, `${i + 1} / ${n}`),
        h('button', { type: 'button', class: `quiet${newest ? '' : ' fresh'}`, 'data-k': `next-${id}`, 'aria-label': newest ? 'Later turn' : 'Later turn (newer replies)', disabled: newest, onclick: () => { if (i + 1 >= n - 1) view.delete(id); else view.set(id, i + 1); draw(id); } }, '›')) : null,
      live && newest ? h('button', { type: 'button', class: 'quiet', onclick: () => go('stop', chat.id, id) }, 'Stop') : null,
      t?.status === 'paused' && newest ? h('button', { type: 'button', onclick: () => go('continue', chat.id, t.id, id) }, 'Continue') : null,
      t && !live && newest && others.length && !['done', 'paused'].includes(t.status) ? h('select', { 'aria-label': 'Continue with another agent', onchange: (e) => { if (e.target.value) go('continue', chat.id, t.id, e.target.value); e.target.value = ''; } }, h('option', { value: '' }, 'Continue with…'), others.map((o) => h('option', { value: o.id }, o.name))) : null);

    const el = h('article', { class: `lane${live ? ' live' : ''}`, 'data-agent': id, 'aria-label': `${a.name}${t ? `, ${STATE[t.status] || ''}` : ''}` }, head);
    if (sent) {
      const long = sent.text.length > 220 || sent.text.split('\n').length > 3, all = full.has(sent.id);
      const label = sent.answers ? 'You answered' : t && sent.targets && !sent.targets.includes(id) ? `You (taken over from ${sent.targets.map((x) => agent(x).name).join(', ')})` : 'You';
      el.append(h('div', { class: `lane-prompt${long && !all ? ' clamp' : ''}` }, h('span', { class: 'lane-who' }, label), h('div', { class: 'lane-said' }, sent.text),
        long ? h('button', { type: 'button', class: 'quiet lane-more', onclick: () => { all ? full.delete(sent.id) : full.add(sent.id); draw(id); } }, all ? 'Show less' : 'Show all') : null));
    }
    const notices = chat.messages.filter((m) => m.role === 'system' && m.agentId === id && between(m, t ? from - 2000 : 0, to));
    if (notices.length) el.append(h('div', { class: 'lane-notices' }, notices.map((m) => h('div', { class: `lane-notice ${m.level || ''}` }, m.text))));
    const body = h('div', { class: 'body' });
    if (t) for (const p of t.parts) body.append(p.type === 'text' ? markdown(p.text) : tools(t, p));
    if (!t || (live && !t.parts.length)) body.append(h('span', { class: 'dim' }, 'Starting…'));
    if (t?.error) body.append(h('p', { class: `err ${t.status}` }, t.error));
    el.append(body);
    if (t?.question) el.append(question(t));
    const notes = chat.messages.filter((m) => m.note && m.agentId === id && between(m, from, to));
    if (notes.length) el.append(h('div', { class: 'lane-notes' }, notes.map((m) => h('div', { class: 'lane-note' }, h('span', { class: 'lane-who' }, 'Note to the team'), markdown(m.parts.map((p) => p.text || '').join('\n\n'))))));
    if (t?.files?.length) el.append(h('div', { class: 'files' }, `Changed ${t.files.join(', ')}`));
    if (t && spend(t)) el.append(h('div', { class: 'files spend', title: SPEND_HELP }, spend(t)));
    return el;
  }

  // Redraws one box in place, keeping a half-written answer and its cursor.
  function draw(id) {
    const old = lanes.get(id);
    if (!old) return render(chat);
    const f = old.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = f?.dataset.q ? `[data-q="${f.dataset.q}"]` : f?.dataset.k ? `[data-k="${f.dataset.k}"]` : null;
    const sel = f && 'selectionStart' in f ? [f.selectionStart, f.selectionEnd] : null;
    const el = lane(id);
    old.replaceWith(el);
    lanes.set(id, el);
    const again = focusKey && el.querySelector(focusKey);
    if (again) { again.focus({ preventScroll: true }); if (sel && again.setSelectionRange) try { again.setSelectionRange(...sel); } catch {} }
  }
  function render(c) {
    if (c?.id !== chat?.id) { view.clear(); full.clear(); }
    chat = c;
    lanes.clear();
    if (!chat) return root.replaceChildren();
    // CopyCLI notices that belong to no one agent, while they are current.
    const lastUser = chat.messages.findLast((m) => m.role === 'user');
    const general = chat.messages.filter((m) => m.role === 'system' && !m.agentId && (!lastUser || m.ts >= lastUser.ts)).slice(-2);
    const grid = h('div', { class: 'lanes' }, ids().map((id) => { const el = lane(id); lanes.set(id, el); return el; }));
    root.replaceChildren(...general.map((m) => h('div', { class: `sys ${m.level || ''}` }, m.text)), grid);
  }
  // A message arrived or changed.
  function update(m) {
    if (!chat) return;
    if (m.role === 'user' || (m.role === 'system' && !m.agentId)) return render(chat);
    if (!lanes.has(m.agentId)) return render(chat);
    draw(m.agentId);
  }
  // Shows the turn a message belongs to, and brings its box into view.
  function reveal(messageId) {
    const m = chat?.messages.find((x) => x.id === messageId);
    if (!m) return;
    const i = turnsOf(m.agentId).indexOf(m);
    if (i >= 0) { if (i === turnsOf(m.agentId).length - 1) view.delete(m.agentId); else view.set(m.agentId, i); draw(m.agentId); }
    lanes.get(m.agentId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  return { render, update, reveal };
}
