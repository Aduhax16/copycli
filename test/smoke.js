// Runs inside Electron (`npm run smoke`). With RELAYDECK_LIVE=codex it also runs that real agent.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { app } from 'electron';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms, what) => { const t = Date.now(); for (;;) { if (await f()) return; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await sleep(100); } };
const PAGE = `<title>Test page</title><h1>Secret word: pineapple</h1><input id=n aria-label="Your name"><input type=password aria-label=Pass><button onclick="document.getElementById('o').textContent='Hello '+document.getElementById('n').value">Greet</button><p id=o></p><a href="http://127.0.0.1:MCP/mcp">mcp</a><script>console.log('page log')</script>`;

export async function smoke({ win, orch, browser, mcp }) {
  let code = 0;
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  const ui = (js) => win.webContents.executeJavaScript(js);
  const shot = async (n) => { if (process.env.RELAYDECK_SHOTS) fs.writeFileSync(path.join(process.env.RELAYDECK_SHOTS, `${n}.png`), (await win.webContents.capturePage()).toPNG()); };
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
    // A tab behind the app still works.
    const b = browser.create('c/b', { front: false });
    assert.match(await browser.open(b, url), /pineapple/);
    assert.ok((await browser.screenshot(b))[0].data.length > 1000);
    browser.close(t.id); browser.close(b.id);
    console.log('browser: ok');

    if (process.env.RELAYDECK_LIVE) {
      const id = process.env.RELAYDECK_LIVE, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-live-'));
      const c = orch.createChat({ cwd: dir });
      c.mode = 'edit'; c.sites.push(new URL(url).host);
      await ui(`document.querySelector('.chat .open').click()`);
      await sleep(500);
      orch.send(c.id, `Use the relaydeck browser_open tool on ${url}, find the secret word, call team_claim for word.txt, then write only that word into word.txt. Be brief.`, [id]);
      await until(() => !orch.live.size, 240000, 'live agent');
      const m = c.messages.find((x) => x.role === 'agent');
      console.log('live:', m.status, m.error || '', '|', m.parts.map((p) => (p.type === 'text' ? p.text : `<${p.name} ${p.status}>`)).join(' '), '| files', m.files);
      assert.equal(m.status, 'done');
      assert.equal(fs.readFileSync(path.join(dir, 'word.txt'), 'utf8').trim(), 'pineapple');
      orch.send(c.id, 'In one word: what did you write in the file?', [id]);
      await until(() => !orch.live.size, 120000, 'second turn');
      console.log('resume:', c.messages.at(-1).parts.map((p) => p.text).join(''));
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
      assert.equal(await ui(`document.querySelectorAll('.body img').length + (window.pwned ? 1 : 0)`), 0);
      assert.equal(await ui(`document.querySelectorAll('.ask').length`), 1);
      await ui(`[...document.querySelectorAll('.ask button')].find((b) => b.textContent === 'Deny').click()`);
      await until(() => !orch.approvals.size, 2000, 'deny');
      await ui(`document.getElementById('agents-btn').click()`);
      await sleep(500);
      await shot('agents');
      assert.ok(!/\bnull\b/.test(await ui(`document.getElementById('agents-dlg').innerText`)));
      console.log('ui: ok');
    }
    assert.deepEqual(errors.filter((e) => !/Autofill|Electron Security/.test(e)), []);
    srv.close(); srv.closeAllConnections();
    console.log('SMOKE OK');
  } catch (e) { code = 1; console.error('SMOKE FAILED', e, errors); }
  orch.shutdown();
  app.exit(code);
}
