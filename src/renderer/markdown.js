// Small Markdown renderer. Builds DOM nodes only, so agent text can never become markup.
const el = (t, ...c) => { const e = document.createElement(t); e.append(...c); return e; };

export function inline(s) {
  const out = [];
  const re = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^\n]+?)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>)\]]*[^\s<>)\].,;:!?'"])|(?<![\w*])\*([^*\n]+)\*(?![\w*])/g;
  let i = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > i) out.push(s.slice(i, m.index));
    if (m[2] !== undefined) out.push(el('code', m[2]));
    else if (m[3] !== undefined) out.push(el('strong', ...inline(m[3])));
    else if (m[5] || m[6]) { const a = el('a', m[4] || m[6]); a.href = m[5] || m[6]; a.title = a.href; out.push(a); }
    else out.push(el('em', m[7]));
    i = m.index + m[0].length;
  }
  if (i < s.length) out.push(s.slice(i));
  return out;
}

export function markdown(src) {
  const frag = document.createDocumentFragment(), L = src.split('\n');
  let i = 0;
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const start = /^(\s*```|#{1,6} |\s*[-*+] |\s*\d+[.)] |>)/;
  while (i < L.length) {
    const l = L[i];
    let m;
    if (!l.trim()) { i++; continue; }
    if ((m = /^\s*(`{3,})/.exec(l))) {
      const code = [];
      for (i++; i < L.length && !L[i].trim().startsWith(m[1]); i++) code.push(L[i]);
      i++;
      frag.append(el('pre', el('code', code.join('\n'))));
    } else if ((m = /^#{1,6} (.*)/.exec(l))) { frag.append(el('h3', ...inline(m[1]))); i++; }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { frag.append(el('hr')); i++; }
    else if (l.startsWith('>')) { const b = []; while (i < L.length && L[i].startsWith('>')) b.push(L[i++].replace(/^>\s?/, '')); const q = el('blockquote'); q.append(markdown(b.join('\n'))); frag.append(q); }
    else if (l.includes('|') && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(L[i + 1] || '') && L[i + 1].includes('|')) {
      const t = el('table', el('tr', ...cells(l).map((c) => el('th', ...inline(c)))));
      for (i += 2; i < L.length && L[i].includes('|'); i++) t.append(el('tr', ...cells(L[i]).map((c) => el('td', ...inline(c)))));
      frag.append(t);
    } else if ((m = /^\s*([-*+]|\d+[.)]) /.exec(l))) {
      const ord = /\d/.test(m[1]), list = el(ord ? 'ol' : 'ul');
      if (ord) list.start = parseInt(m[1], 10);
      const re = ord ? /^\s*\d+[.)] (.*)/ : /^\s*[-*+] (.*)/;
      for (let k; i < L.length && ((k = re.exec(L[i])) || (/^\s{2,}\S/.test(L[i]) && list.lastChild)); i++) {
        if (k) list.append(el('li', ...inline(k[1]))); else list.lastChild.append(' ', ...inline(L[i].trim()));
      }
      frag.append(list);
    } else { const p = []; do p.push(L[i++]); while (i < L.length && L[i].trim() && !start.test(L[i])); frag.append(el('p', ...inline(p.join('\n')))); }
  }
  return frag;
}
