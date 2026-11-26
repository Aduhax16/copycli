// Runs inside Electron (`npm run smoke`). With COPYCLI_LIVE=codex it also runs that real agent.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { app, nativeImage } from 'electron';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms, what) => { const t = Date.now(); for (;;) { if (await f()) return; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await sleep(100); } };
const PAGE = `<title>Test page</title><h1>Secret word: pineapple</h1><input id=n aria-label="Your name"><input type=password aria-label=Pass><button onclick="document.getElementById('o').textContent='Hello '+document.getElementById('n').value">Greet</button><p id=o></p><a href="http://127.0.0.1:MCP/mcp">mcp</a><script>console.log('page log')</script>`;

export async function smoke({ win, orch, browser, mcp, store }) {
  let code = 0;
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  const ui = (js) => win.webContents.executeJavaScript(js);
  const shot = async (n) => { if (process.env.COPYCLI_SHOTS) fs.writeFileSync(path.join(process.env.COPYCLI_SHOTS, `${n}.png`), (await win.webContents.capturePage()).toPNG()); };
  try {
    const srv = http.createServer((q, s) => s.setHeader('content-type', 'text/html').end(PAGE.replace('MCP', mcp.port)));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/`;

    // UI loads.
    await until(() => ui(`!!document.querySelector('.empty')`), 8000, 'ui');
    await orch.refreshAgents();
    console.log('agents:', orch.agents().filter((a) => a.installed).map((a) => `${a.id}${a.signedIn === false ? ' (signed out)' : ''}`).join(', ') || 'none');

    // Conversation management exercises the real IPC and persisted chat metadata.
    const libraryChat = orch.createChat({ cwd: os.tmpdir() });
    await until(() => ui(`!!document.querySelector('[data-chat-id="${libraryChat.id}"] .open')`), 3000, 'library chat');
    await ui(`document.querySelector('[data-chat-id="${libraryChat.id}"] .open').click()`);
    const libraryAction = async (text) => {
      await ui(`document.querySelector('[data-chat-id="${libraryChat.id}"] .cb-more').click()`);
      await ui(`[...document.querySelectorAll('.cb-menu-item')].find((e) => e.textContent === ${JSON.stringify(text)}).click()`);
    };
    const librarySave = async (value) => {
      await until(() => ui(`!!document.querySelector('.cb-dialog .cb-field')`), 8000, 'library dialog');
      await ui(`document.querySelector('.cb-field').value=${JSON.stringify(value)};document.querySelector('.cb-dialog [type=submit]').click()`);
      await until(() => ui(`!document.querySelector('.cb-dialog')`), 8000, 'library save');
    };
    await libraryAction('Rename'); await librarySave('Organized conversation');
    assert.equal(libraryChat.title, 'Organized conversation');
    await libraryAction('Pin to top'); await until(() => libraryChat.pinned, 2000, 'library pin');
    await libraryAction('Move to group…'); await librarySave('Projects');
    assert.equal(libraryChat.group, 'Projects');
    await libraryAction('Archive chat'); await until(() => libraryChat.archived, 2000, 'library archive');
    await until(() => ui(`!document.querySelector('[data-chat-id="${libraryChat.id}"]')`), 2000, 'archived chat hidden');
    await ui(`document.querySelectorAll('.cb-filters button')[1].click()`);
    await libraryAction('Restore chat'); await until(() => !libraryChat.archived, 2000, 'library restore');
    await ui(`document.querySelectorAll('.cb-filters button')[0].click()`);
    store.flushAll();
    const savedLibrary = JSON.parse(fs.readFileSync(path.join(store.dir, `${libraryChat.id}.json`), 'utf8'));
    assert.deepEqual([savedLibrary.title, savedLibrary.group, savedLibrary.pinned, savedLibrary.archived], ['Organized conversation', 'Projects', true, false]);
    // Keep the remaining smoke scenarios independent from the library fixture.
    orch.deleteChat(libraryChat.id);

    // Browser: read, type, click, screenshot, refusals.
    const t = browser.create('c/a');
    assert.match(await browser.open(t, url), /pineapple/);
    const ref = async (name) => new RegExp(`\\[(e\\d+)\\][^\\n]*${name}`).exec(await browser.read(t))[1];
    await browser.type(t, { ref: await ref('Your name'), text: 'Ada' });
    assert.match(await browser.click(t, { ref: await ref('Greet') }), /Hello Ada/);
    await assert.rejects(async () => browser.type(t, { ref: await ref('Pass'), text: 'x' }), /password/);
    assert.ok((await browser.screenshot(t))[0].data.length > 1000);
    assert.ok(t.logs.some((l) => l.includes('page log')));
    await assert.rejects(browser.open(t, mcp.url), /blocked/);
    await assert.rejects(browser.open(t, 'file:///etc/hosts'), /Only http/);
    // Same-page actions report only what changed; smooth scrolling and covered elements still get clicked.
    const L = http.createServer((q, s) => { if (q.url === '/two') return s.setHeader('content-type', 'text/html').end('<title>Two</title><p>Second page'); s.setHeader('content-type', 'text/html').end(`<style>:root{scroll-behavior:smooth}</style><title>Long</title><p>top words ${'x '.repeat(50)}</p><div style="height:4000px"></div><div style="position:relative"><a href="/two">Taller TNUI</a><div style="position:absolute;inset:0"></div></div>`); });
    await new Promise((r) => L.listen(0, '127.0.0.1', r));
    await browser.open(t, `http://127.0.0.1:${L.address().port}/`);
    assert.match(await browser.find(t, 'tnui'), /\[e\d+\] a "Taller TNUI"/);
    assert.ok(!(await browser.scroll(t, 'down')).includes('top words'));
    assert.match(await browser.click(t, { text: 'taller tnui' }), /Second page/);
    const size = Buffer.from((await browser.screenshot(t))[0].data, 'base64');
    assert.ok(size.length < 400000);
    // A page whose third-party script never answers is readable, not an error.
    const hang = http.createServer(() => {});
    await new Promise((r) => hang.listen(0, '127.0.0.1', r));
    const H = http.createServer((q, s) => s.setHeader('content-type', 'text/html').end(`<title>Slow</title><script src="http://localhost:${hang.address().port}/x.js"></script><p>exam on friday</p>`));
    await new Promise((r) => H.listen(0, '127.0.0.1', r));
    const t0 = Date.now();
    let slow = await browser.open(t, `http://127.0.0.1:${H.address().port}/`);
    assert.match(slow, /exam on friday/);
    console.log(`stalled script: readable in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const x of [L, hang, H]) { x.close(); x.closeAllConnections(); }
    if (process.env.COPYCLI_SITE) { const t1 = Date.now(); const r = await browser.open(t, process.env.COPYCLI_SITE); console.log('site:', ((Date.now() - t1) / 1000).toFixed(1) + 's', r.length, 'chars', r.slice(0, 300).replace(/\n/g, ' | ')); }
    // A tab behind the app still works.
    const b = browser.create('c/b', { front: false });
    assert.match(await browser.open(b, url), /pineapple/);
    assert.ok((await browser.screenshot(b))[0].data.length > 1000);
    // It must not cover the app, must keep drawing, and must take real clicks.
    const overApp = (v) => { const r = v.getBounds(), [w, h] = win.getContentSize(); return Math.max(0, Math.min(r.x + r.width, w) - Math.max(r.x, 0)) * Math.max(0, Math.min(r.y + r.height, h) - Math.max(r.y, 0)); };
    const visible = () => [...browser.tabs.values()].filter((x) => overApp(x.view) > 1).map((x) => x.id);
    browser.setBounds({ x: 700, y: 100, width: 600, height: 600 });
    assert.deepEqual(visible(), [t.id], 'only the open tab is over the app');
    browser.select(b.id);
    assert.deepEqual(visible(), [b.id]);
    browser.select(t.id);
    browser.setBounds(null);
    assert.deepEqual(visible(), [], 'a closed browser panel leaves no tab over the app');
    assert.equal(await browser.js(b, `new Promise((r) => { let n = 0; const f = () => (++n === 10 ? r('drawing') : requestAnimationFrame(f)); f(); setTimeout(() => r('stopped at ' + n), 3000); })`), 'drawing');
    for (let i = 0; i < 6; i++) {
      const im = nativeImage.createFromBuffer(Buffer.from((await browser.screenshot(b))[0].data, 'base64'));
      assert.equal(im.getSize().width, await browser.js(b, 'innerWidth'), 'one image pixel per page pixel');
    }
    await browser.js(b, `document.querySelector('button').addEventListener('click', (e) => { globalThis.__trusted = e.isTrusted; })`);
    await browser.click(b, { text: 'Greet' });
    assert.equal(await browser.js(b, 'globalThis.__trusted'), true);
    browser.close(t.id); browser.close(b.id);
    console.log('browser: ok');

    if (process.env.COPYCLI_LIVE) {
      const id = process.env.COPYCLI_LIVE, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-live-'));
      const c = orch.createChat({ cwd: dir });
      c.mode = 'edit'; c.sites.push(new URL(url).host);
      await ui(`document.querySelector('.chat .open').click()`);
      await sleep(500);
      store.settings.efforts[id] = 'low';
      if (process.env.COPYCLI_MODEL) store.settings.models[id] = process.env.COPYCLI_MODEL;
      await until(() => orch.models(id).length, 20000, 'models');
      console.log('models:', orch.models(id).map((m) => m.id).join(', '), '| limits', JSON.stringify(orch.windows(id).map((w) => w.usedPercent)));
      orch.send(c.id, `Use the copycli browser_open tool on ${url}, find the secret word, call team_claim for word.txt, then write only that word into word.txt. Be brief.`, [id]);
      await until(() => !orch.live.size, 240000, 'live agent');
      const m = c.messages.find((x) => x.role === 'agent');
      console.log('live:', m.status, m.error || '', '|', m.parts.map((p) => (p.type === 'text' ? p.text : `<${p.name} ${p.status}>`)).join(' '), '| files', m.files);
      console.log('usage:', JSON.stringify(m.usage), 'spent', m.spent);
      assert.equal(m.status, 'done');
      assert.equal(fs.readFileSync(path.join(dir, 'word.txt'), 'utf8').trim(), 'pineapple');
      orch.send(c.id, 'In one word: what did you write in the file?', [id]);
      await until(() => !orch.live.size, 120000, 'second turn');
      console.log('resume:', c.messages.at(-1).parts.map((p) => p.text).join(''), JSON.stringify(c.messages.at(-1).usage));
      await sleep(600);
      await shot('live');
      console.log('live agent: ok');
    }
    // Several agents in one chat: layout, approvals, markup safety.
    {
      // These checks need three agents; computers without them (CI) get stand-ins that are never run.
      for (const id of ['claude', 'codex', 'antigravity']) if (!orch.usable().some((a) => a.id === id)) orch.status.set(id, { installed: true, path: '/usr/bin/false', signedIn: true });
      orch.emit('agents', orch.agents());
      const c = orch.createChat({ cwd: os.tmpdir() });
      c.title = 'Landing page';
      orch.emit('chats', orch.listChats());
      orch.updateChat(c.id, {});
      await until(() => ui(`document.querySelector('.chat .open')?.textContent.includes('Landing page')`), 3000, 'chat list');
      await ui(`document.querySelector('.chat .open').click()`);
      await sleep(400);
      const round = 'r1', add = (m) => orch.push(c, m);
      add({ role: 'user', text: 'Build a landing page. @claude write the HTML @codex write the CSS @antigravity check it in the browser', targets: ['claude', 'codex', 'antigravity'], round });
      add({ role: 'agent', agentId: 'claude', round, status: 'limit', task: 'x', error: "You've hit your limit", files: ['index.html'], parts: [{ type: 'text', text: 'I claimed `index.html` and started the **hero**.\n\n<img src=x onerror="window.pwned=1">' }, { type: 'tool', id: '1', name: 'Write', detail: 'index.html', status: 'done', output: 'ok' }] });
      add({ role: 'agent', agentId: 'codex', round, status: 'running', task: 'x', files: ['style.css'], parts: [{ type: 'tool', id: '2', name: 'Edit', detail: 'style.css', status: 'done' }, { type: 'text', text: 'Claude owns the markup, so I am styling its class names:\n\n```css\n.hero { display: grid; }\n```' }] });
      add({ role: 'agent', agentId: 'antigravity', round, status: 'running', task: 'x', files: [], parts: [{ type: 'tool', id: '3', name: 'browser_open', detail: 'localhost:8000', status: 'running' }] });
      add({ role: 'system', agentId: 'codex', level: 'limit', text: 'Claude ran out of usage until 15:00. Codex is continuing.' });
      orch.askApproval(c, 'codex', { title: 'Run a command', detail: 'npm run build', canAlways: true });
      await ui(`document.getElementById('browser-btn').click()`);
      await sleep(900);
      await shot('multi');
      assert.equal(await ui(`document.querySelectorAll('.round .agent').length`), 3);
      // Buttons at the right go to each agent's latest message.
      await until(() => ui(`[...document.querySelectorAll('#jump .jump-item')].map((e) => e.dataset.agent).join()`).then((v) => v === 'claude,codex,antigravity'), 2000, 'jump buttons');
      assert.equal(await ui(`document.getElementById('jump').hidden`), false);
      await ui(`document.getElementById('log').scrollTop = 0`);
      await ui(`document.querySelector('#jump .jump-item[data-agent=antigravity]').click()`);
      await until(() => ui(`(() => { const r = [...document.querySelectorAll('.round .agent')].find((e) => e.querySelector('header').textContent.startsWith('Antigravity')).getBoundingClientRect(), l = document.getElementById('log').getBoundingClientRect(); return r.top < l.bottom && r.bottom > l.top; })()`), 3000, 'jumped to antigravity');
      assert.equal(await ui(`document.querySelector('.agent.flash header').textContent.startsWith('Antigravity')`), true, 'the card it jumps to is highlighted');
      assert.ok(await ui(`(() => { const s = document.getElementById('send').getBoundingClientRect(), c = document.getElementById('composer').getBoundingClientRect(); return c.right - s.right < 24; })()`), 'Send stays at the right edge next to the browser');
      // Status strip shows mixed outcomes and updates the existing turn in place.
      const statuses = () => ui(`Object.fromEntries([...document.querySelectorAll('#agent-status .as-pill')].map((e) => [e.dataset.agent, e.dataset.status]))`);
      assert.deepEqual(await statuses(), { claude: 'limit', codex: 'running', antigravity: 'running' });
      const codexTurn = c.messages.find((m) => m.role === 'agent' && m.agentId === 'codex');
      await ui(`window.statusFocusTarget = document.querySelector('.as-pill[data-agent="codex"]'); window.statusFocusTarget.focus()`);
      orch.touch(c, codexTurn);
      await sleep(150);
      assert.equal(await ui(`document.activeElement === window.statusFocusTarget && window.statusFocusTarget.isConnected`), true, 'streaming retains status keyboard focus');
      codexTurn.status = 'done'; orch.touch(c, codexTurn);
      await until(async () => (await statuses()).codex === 'done', 2000, 'status done');
      assert.equal((await statuses()).antigravity, 'running');
      for (const status of ['paused', 'error', 'cancelled', 'limit', 'running']) {
        codexTurn.status = status; orch.touch(c, codexTurn);
        await until(async () => (await statuses()).codex === status, 2000, `status ${status}`);
      }
      assert.match(await ui(`document.querySelector('.as-pill[data-agent="codex"]').getAttribute('aria-label')`), /Codex: Working/);
      for (let i = 0; i < 6; i++) add({ role: 'agent', agentId: 'claude', note: true, status: 'done', files: [], parts: [{ type: 'text', text: 'A note for the team' }] });
      await sleep(300);
      assert.ok(await ui(`[...document.querySelectorAll('.agent.note')].every((e) => e.offsetHeight > 40)`), 'notes keep their height');
      assert.equal((await statuses()).claude, 'limit', 'team notes do not mark an agent done');
      assert.equal(await ui(`document.querySelectorAll('.body img').length + (window.pwned ? 1 : 0)`), 0);
      assert.equal(await ui(`document.querySelectorAll('.ask').length`), 1);
      await ui(`[...document.querySelectorAll('.ask button')].find((b) => b.textContent === 'Deny').click()`);
      await until(() => !orch.approvals.size, 2000, 'deny');
      // A question is answered in the asking agent's card.
      add({ role: 'user', text: 'Now add a footer', targets: ['claude'], round: 'r2' });
      const second = add({ role: 'agent', agentId: 'claude', round: 'r2', status: 'done', task: 'x', files: [], parts: [{ type: 'text', text: 'Footer added.' }] });
      second.question = { id: 'q1', text: 'Blue or red?', pauseOthers: true, at: Date.now() };
      orch.touch(c, second);
      await until(() => ui(`!!document.querySelector('.agent .question textarea')`), 2000, 'question');
      const asking = () => ui(`document.querySelector('.agent .question').innerText`);
      assert.match(await asking(), /Claude is asking you[\s\S]*Others wait for your answer[\s\S]*Blue or red\?/);
      await shot('question');
      const answered = [], realAnswer = orch.answer;
      orch.answer = (chatId, msgId, text) => { answered.push([chatId, msgId, text]); second.question.answer = text; orch.touch(c, second); };
      await ui(`(() => { const t = document.querySelector('.question textarea'); t.focus(); t.value = 'Bl'; t.dispatchEvent(new Event('input')); })()`);
      // Streaming into the card keeps a half-written answer and its focus.
      orch.touch(c, second);
      await sleep(150);
      assert.equal(await ui(`document.activeElement.dataset.q + ':' + document.activeElement.value`), 'q1:Bl');
      await ui(`(() => { const t = document.activeElement; t.value = 'Blue'; t.dispatchEvent(new Event('input')); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
      await until(() => answered.length === 1, 2000, 'answer sent');
      assert.deepEqual(answered[0], [c.id, second.id, 'Blue']);
      await until(async () => /You answered\s*Blue/.test(await asking()), 2000, 'answer shown');
      orch.answer = realAnswer;
      // The jump button follows Claude's newest message.
      await until(() => ui(`document.querySelector('#jump .jump-item[data-agent=claude]')?.dataset.msg === ${JSON.stringify(second.id)}`), 2000, 'jump follows newest');
      // Mentions: the menu offers each agent under its short name.
      if (orch.usable().some((a) => a.id === 'antigravity')) {
        await ui(`(() => { const i = document.getElementById('input'); i.focus(); i.value = '@gem'; i.setSelectionRange(4, 4); i.dispatchEvent(new Event('input')); })()`);
        assert.match(await ui(`document.getElementById('mentions').innerText`), /Antigravity\s*@gemini/);
        await shot('mentions');
        await ui(`document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true }))`);
        assert.equal(await ui(`document.getElementById('input').value`), '@gemini ');
        await ui(`document.getElementById('input').value = ''`);
      }
      // Opening another chat clears the previous chat's strip; returning restores it.
      const blank = orch.createChat({ cwd: os.tmpdir() });
      await until(() => ui(`document.querySelectorAll('.chat .open').length === 2`), 3000, 'second chat');
      await ui(`document.querySelectorAll('.chat .open')[0].click()`);
      await until(() => ui(`document.getElementById('agent-status').hidden`), 2000, 'empty chat status');
      assert.deepEqual(await statuses(), {});
      orch.emit('open-chat', c.id);
      await until(async () => (await statuses()).claude === 'done', 2000, 'restored chat status');
      assert.equal(await ui(`document.querySelectorAll('#jump .jump-item').length`), 3, 'jump buttons come back with the chat');
      // Remaining quota is shown for all three providers, not just Codex.
      const quotaReset = Date.now() / 1000 + 3600;
      for (const [id, usedPercent] of [['claude', 27], ['codex', 70], ['antigravity', 4]]) orch.recordUsage(id, [{ usedPercent, resetsAt: quotaReset, minutes: 300 }]);
      orch.emit('agents', orch.agents());
      await until(() => ui(`document.querySelector('#targets .chip .pct[aria-label="Antigravity: 96% remaining"]') !== null`), 2000, 'all agent quotas');
      assert.match(await ui(`document.getElementById('targets').innerText`), /73% left/);
      assert.match(await ui(`document.getElementById('targets').innerText`), /30% left/);
      const savedQuota = orch.usage.get('antigravity');
      orch.usage.delete('antigravity'); orch.emit('agents', orch.agents());
      await until(() => ui(`document.querySelector('#targets [aria-label="Antigravity: remaining quota unavailable"]')?.textContent === '—'`), 2000, 'unknown quota');
      orch.recordUsage('antigravity', savedQuota); orch.emit('agents', orch.agents());
      // Settings: every section draws, changes are saved, Escape closes it.
      c.sites.push('example.com');
      await ui(`document.getElementById('settings-btn').click()`);
      const nav = async (n) => { await ui(`document.querySelector('[data-k="nav-${n}"]').click()`); await until(() => ui(`document.querySelector('.st-main')?.dataset.section === '${n}'`), 3000, n); };
      const press = async (k) => { await ui(`document.querySelector('[data-k="${k}"]').click()`); await sleep(250); };
      await until(() => ui(`!!document.querySelector('.st-main')`), 3000, 'settings');
      for (const n of await ui(`[...document.querySelectorAll('.st-nav')].map((e) => e.dataset.k.slice(4))`)) {
        await nav(n);
        if (n === 'agents') await ui(`document.querySelector('.st-open')?.click()`);
        if (n === 'usage') { assert.match(await ui(`document.querySelector('.st-main').innerText`), /73% left/); assert.equal(await ui(`document.querySelector('[aria-label="Claude 5 h remaining"]').getAttribute('aria-valuenow')`), '73'); }
        await sleep(300);
        await shot(`settings-${n}`);
        assert.ok(!/\b(null|undefined|NaN)\b|\[object/.test(await ui(`document.getElementById('settings').innerText`)), n);
        assert.ok(await ui(`(() => { const m = document.querySelector('.st-main'); return m.scrollWidth <= m.clientWidth; })()`), `${n} fits`);
      }
      await nav('general');
      await press('theme-light');
      assert.equal(store.settings.theme, 'light');
      assert.equal(await ui(`matchMedia('(prefers-color-scheme: light)').matches`), true);
      await shot('settings-light');
      await press('theme-dark'); await press('send-mod'); await press('notify');
      assert.deepEqual([store.settings.theme, store.settings.sendKey, store.settings.notify], ['dark', 'mod', false]);
      await ui(`(() => { const t = document.querySelector('.st-text'); t.focus(); t.value = 'Be brief.'; t.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(200);
      assert.equal(store.settings.instructions, 'Be brief.');
      // A redraw must not take away what is being typed.
      await nav('agents');
      await ui(`(() => { const t = document.querySelector('[data-k=add-name]'); t.focus(); t.value = 'half'; t.dispatchEvent(new Event('input')); })()`);
      orch.emit('agents', orch.agents());
      await sleep(250);
      assert.equal(await ui(`document.activeElement.dataset.k + document.activeElement.value`), 'add-namehalf');
      await nav('permissions');
      await press('mode-plan');
      assert.equal(orch.createChat({ cwd: os.tmpdir() }).mode, 'plan');
      await press(`site-${c.id}-example.com`);
      assert.ok(!c.sites.includes('example.com'));
      await ui(`dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))`);
      assert.equal(await ui(`document.getElementById('settings').hidden && !document.getElementById('main').inert`), true);
      console.log('ui: ok');
    }
    assert.deepEqual(errors.filter((e) => !/Autofill|Electron Security/.test(e)), []);
    srv.close(); srv.closeAllConnections();
    console.log('SMOKE OK');
  } catch (e) { code = 1; console.error('SMOKE FAILED', e, errors); }
  orch.shutdown();
  app.exit(code);
}
