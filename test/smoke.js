// Runs inside Electron (`npm run smoke`). With COPYCLI_LIVE=codex it also runs that real agent.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { app } from 'electron';

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
      const c = orch.createChat({ cwd: os.tmpdir() });
      c.title = 'Landing page';
      orch.emit('chats', orch.listChats());
      orch.updateChat(c.id, {});
      await ui(`document.querySelector('.chat .open').click()`);
      await sleep(400);
      const round = 'r1', add = (m) => orch.push(c, m);
      add({ role: 'user', text: 'Build a landing page. @claude write the HTML @codex write the CSS @antigravity check it in the browser', targets: ['claude', 'codex', 'antigravity'], round });
      add({ role: 'agent', agentId: 'claude', round, status: 'limit', task: 'x', error: "You've hit your limit", files: ['index.html'], parts: [{ type: 'text', text: 'I claimed `index.html` and started the **hero**.\n\n<img src=x onerror="window.pwned=1">' }, { type: 'tool', id: '1', name: 'Write', detail: 'index.html', status: 'done', output: 'ok' }] });
      add({ role: 'agent', agentId: 'codex', round, status: 'running', task: 'x', files: ['style.css'], parts: [{ type: 'tool', id: '2', name: 'Edit', detail: 'style.css', status: 'done' }, { type: 'text', text: 'Claude owns the markup, so I am styling its class names:\n\n```css\n.hero { display: grid; }\n```' }] });
      add({ role: 'agent', agentId: 'antigravity', round, status: 'running', task: 'x', files: [], parts: [{ type: 'tool', id: '3', name: 'browser_open', detail: 'localhost:8000', status: 'running' }] });
      add({ role: 'system', level: 'limit', text: 'Claude ran out of usage until 15:00. Codex is continuing.' });
      orch.askApproval(c, 'codex', { title: 'Run a command', detail: 'npm run build', canAlways: true });
      await ui(`document.getElementById('browser-btn').click()`);
      await sleep(900);
      await shot('multi');
      assert.equal(await ui(`document.querySelectorAll('.round .agent').length`), 3);
      for (let i = 0; i < 6; i++) add({ role: 'agent', agentId: 'claude', note: true, status: 'done', files: [], parts: [{ type: 'text', text: 'A note for the team' }] });
      await sleep(300);
      assert.ok(await ui(`[...document.querySelectorAll('.agent.note')].every((e) => e.offsetHeight > 40)`), 'notes keep their height');
      assert.equal(await ui(`document.querySelectorAll('.body img').length + (window.pwned ? 1 : 0)`), 0);
      assert.equal(await ui(`document.querySelectorAll('.ask').length`), 1);
      await ui(`[...document.querySelectorAll('.ask button')].find((b) => b.textContent === 'Deny').click()`);
      await until(() => !orch.approvals.size, 2000, 'deny');
      // Settings: every section draws, changes are saved, Escape closes it.
      c.sites.push('example.com');
      await ui(`document.getElementById('settings-btn').click()`);
      const nav = async (n) => { await ui(`document.querySelector('[data-k="nav-${n}"]').click()`); await until(() => ui(`document.querySelector('.st-main')?.dataset.section === '${n}'`), 3000, n); };
      const press = async (k) => { await ui(`document.querySelector('[data-k="${k}"]').click()`); await sleep(250); };
      await until(() => ui(`!!document.querySelector('.st-main')`), 3000, 'settings');
      for (const n of await ui(`[...document.querySelectorAll('.st-nav')].map((e) => e.dataset.k.slice(4))`)) {
        await nav(n);
        if (n === 'agents') await ui(`document.querySelector('.st-open')?.click()`);
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
