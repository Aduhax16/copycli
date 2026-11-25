// Compact live agent status strip in the header.
export const STATUS_META = {
  running: { label: 'Working', glyph: 'spinner' },
  done: { label: 'Done', glyph: 'check' },
  paused: { label: 'Paused', glyph: 'pause' },
  limit: { label: 'Out of usage', glyph: 'warn' },
  error: { label: 'Error', glyph: 'cross' },
  cancelled: { label: 'Stopped', glyph: 'stop' },
};

const GLYPHS = {
  spinner: ['M12 3a9 9 0 1 0 9 9'],
  check: ['M5 12.5 9.5 17 19 7.5'],
  pause: ['M9 6v12', 'M15 6v12'],
  warn: ['M12 4 3.5 19h17L12 4Z', 'M12 10v4', 'M12 16.8h.01'],
  cross: ['M6 6l12 12', 'M18 6 6 18'],
  stop: ['M7 7h10v10H7z'],
};

function glyphSvg(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `as-icon as-icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of GLYPHS[name] || GLYPHS.check) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * Compute per-agent statuses for the active round of a chat.
 * Ignores team notes (`m.note`) and system messages, preserves teammates'
 * statuses within the current round, and keeps any still-running agent visible.
 */
export function collectStatuses(messages = []) {
  if (!Array.isArray(messages) || !messages.length) return [];

  let activeRound = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.note) continue;
    if ((m.role === 'agent' || m.role === 'user') && m.round) {
      activeRound = m.round;
      break;
    }
  }

  const byAgent = new Map();
  if (activeRound) {
    for (const m of messages) {
      if (!m || m.role !== 'agent' || m.note || m.round !== activeRound) continue;
      byAgent.set(m.agentId, {
        agentId: m.agentId,
        status: m.status || 'done',
        messageId: m.id,
      });
    }
  }

  // Keep any agent still running from an earlier round visible too.
  for (const m of messages) {
    if (!m || m.role !== 'agent' || m.note || m.status !== 'running') continue;
    if (!byAgent.has(m.agentId)) {
      byAgent.set(m.agentId, {
        agentId: m.agentId,
        status: 'running',
        messageId: m.id,
      });
    }
  }

  return [...byAgent.values()];
}

export function createAgentStatus({ root, h, agent, dot, onSelect }) {
  let lastKey;
  function render(chat) {
    const items = chat ? collectStatuses(chat.messages) : [];
    const key = JSON.stringify([chat?.id, items.map((it) => { const a = agent(it.agentId); return [it.agentId, it.status, it.messageId, a.name, a.color]; })]);
    if (key === lastKey) return;
    lastKey = key;
    root.hidden = !items.length;
    if (!items.length) {
      root.replaceChildren();
      root.setAttribute('aria-label', 'Agent status');
      return;
    }
    const summary = items
      .map((it) => `${agent(it.agentId).name}: ${(STATUS_META[it.status] || STATUS_META.done).label}`)
      .join(', ');
    root.setAttribute('aria-label', `Agent status: ${summary}`);
    root.replaceChildren(
      ...items.map((it) => {
        const a = agent(it.agentId);
        const meta = STATUS_META[it.status] || { label: it.status, glyph: 'check' };
        const live = it.status === 'running';
        return h(
          'button',
          {
            type: 'button',
            class: 'as-pill',
            'data-agent': it.agentId,
            'data-status': it.status,
            title: `${a.name} · ${meta.label}`,
            'aria-label': `${a.name}: ${meta.label}`,
            onclick: () => onSelect?.(it.messageId),
          },
          dot(it.agentId, live),
          h('span', { class: 'as-name' }, a.name),
          h('span', { class: 'as-sym', 'aria-hidden': 'true' }, glyphSvg(meta.glyph)),
        );
      }),
    );
  }

  return { render };
}
