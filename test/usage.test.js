import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeUsage, claudeRateUsage, agyUsage } from '../src/main/agents/quotas.js';
import { remainingPercent, quotaTooltip } from '../src/shared/usage.js';
import { Orchestrator } from '../src/main/orchestrator.js';
import { Store } from '../src/main/store.js';
import { probeUsage } from '../src/main/agents/probe.js';
const reset = new Date(Date.now() + 3600000).toISOString();
const claude = { rate_limits: { five_hour: { utilization: 27, resets_at: reset }, seven_day: { utilization: 8, resets_at: reset }, seven_day_opus: { utilization: 4, resets_at: reset }, seven_day_sonnet: null, extra_usage: { utilization: 90 } } };
const gemini = { groups: [
  { name: 'Gemini Models', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: .96, reset_time: reset }, { id: 'gemini-weekly', window: 'weekly', remaining_fraction: .99, reset_time: reset }] },
  { name: 'Claude and GPT models', buckets: [{ id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: reset }] },
] };
function setup(usageProber) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'copycli-usage-'))), events = [];
  const o = new Orchestrator({ store, emit: (...a) => events.push(a), detector: async () => ({ installed: true }), usageProber });
  for (const id of ['claude', 'codex', 'antigravity']) o.status.set(id, { installed: true, path: '/test' });
  return { o, events };
}
test('Claude quota snapshots use percentages; stream events use fractions', () => {
  const windows = claudeUsage(claude);
  assert.equal(remainingPercent(windows), 73);
  assert.equal(windows[0].minutes, 300);
  assert.equal(windows[1].minutes, 10080);
  assert.ok(windows.every((w) => Number.isFinite(w.resetsAt)));
  assert.equal(claudeUsage({ rate_limits: { five_hour: { utilization: 1 } } })[0].usedPercent, 1);
  assert.equal(claudeRateUsage({ rateLimitType: 'five_hour', utilization: 1 })[0].usedPercent, 100);
  assert.equal(claudeRateUsage({ rateLimitType: 'seven_day', utilization: .27 })[0].usedPercent, 27);
  assert.deepEqual(claudeUsage({ rate_limits: { five_hour: { utilization: null } } }), []);
  assert.deepEqual(claudeRateUsage({ rateLimitType: 'unknown', utilization: .5 }), []);
});
test('Gemini quota groups are independent and missing percentages stay unknown', () => {
  const w = agyUsage(gemini);
  assert.equal(remainingPercent(w.filter((x) => x.scope === 'gemini')), 96);
  assert.equal(remainingPercent(w.filter((x) => x.scope === 'third-party')), 100);
  assert.deepEqual(agyUsage({ groups: [{ buckets: [{ window: '5h', remaining_amount: 500 }, { window: '5h', remaining_fraction: null }] }] }), []);
  assert.equal(remainingPercent([]), null);
  assert.equal(remainingPercent([{ usedPercent: NaN }]), null);
  assert.equal(remainingPercent([{ usedPercent: 0 }]), 100);
  assert.equal(remainingPercent([{ usedPercent: 120 }]), 0);
  assert.match(quotaTooltip({ usage: w.slice(0, 1) }), /Gemini Models.*96% left/);
});
test('quota selection follows the selected model and partial events preserve other windows', () => {
  const { o } = setup();
  o.recordUsage('antigravity', agyUsage(gemini));
  o.store.settings.models.antigravity = 'gemini-4-neon';
  assert.equal(remainingPercent(o.windows('antigravity')), 96);
  o.store.settings.models.antigravity = 'claude-opus-5-5';
  assert.equal(remainingPercent(o.windows('antigravity')), 100);
  assert.equal(o.allWindows('antigravity').length, 3);
  o.recordUsage('claude', claudeUsage(claude));
  o.recordUsage('claude', claudeRateUsage({ rateLimitType: 'five_hour', utilization: .4, resetsAt: Date.parse(reset) / 1000 }), true);
  assert.equal(o.windows('claude').length, 2);
  assert.equal(remainingPercent(o.windows('claude')), 60);
  assert.equal(o.windows('claude').find((w) => w.minutes === 10080).usedPercent, 8);
  o.store.settings.models.claude = 'claude-opus-5';
  const before = o.windows('claude').map((w) => ({ ...w }));
  const scoped = before.find((w) => w.scope === 'opus');
  o.recordUsage('claude', [{ ...scoped, usedPercent: 6 }], true);
  assert.equal(o.spent({ agentId: 'claude', startUsage: before }), 2, 'same-duration model pools keep separate baselines');
  o.usageUpdated.set('claude', Date.now() - 16 * 60000);
  assert.deepEqual(o.windows('claude'), []);
  o.recordUsage('codex', [{ usedPercent: 50, resetsAt: Date.now() / 1000 - 5, minutes: 300 }]);
  assert.deepEqual(o.windows('codex'), []);
});
test('quota polling coalesces reads, refreshes UI, and does not run model drivers', async () => {
  let reads = 0, resolve;
  const { o, events } = setup(async () => { reads++; await new Promise((r) => { resolve = r; }); return { usage: claudeUsage(claude) }; });
  const a = o.refreshUsage('claude'), b = o.refreshUsage('claude');
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1); resolve(); await Promise.all([a, b]);
  assert.equal(remainingPercent(o.agents().find((x) => x.id === 'claude').usage), 73);
  assert.equal(events.filter(([name]) => name === 'usage').length, 1);
  await o.refreshUsage('claude'); assert.equal(reads, 1);
  assert.equal(o.drivers.size, 0);
  o.probeUsage = () => { throw new Error('offline'); };
  o.usageQueried.set('claude', 0);
  await o.refreshUsage('claude'); assert.equal(o.quotaReads.size, 0);
  assert.equal(remainingPercent(o.windows('claude')), 73);
});
test('CLI quota probes read provider commands without sending a model prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copycli-quota-cli-'));
  const fake = path.join(dir, 'cli.cjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nconst rl=require('node:readline');
if(process.argv.includes('/usage')) { console.log(JSON.stringify({event:'command_result',command:{name:'usage',data:${JSON.stringify(gemini)}}})); process.exit(0); }
rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.type!=='control_request')process.exit(2); const init=m.request.subtype==='initialize'; if(!init && (m.request.subtype!=='get_usage'||m.request.skip_behaviors!==true))process.exit(3); console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:init?{models:[]}:${JSON.stringify(claude)}}}));});`, { mode: 0o700 });
  try {
    const c = await probeUsage({ kind: 'claude' }, fake, process.env, 'test');
    const g = await probeUsage({ probe: 'agy' }, fake, process.env, 'test');
    assert.equal(remainingPercent(c.usage), 73);
    assert.equal(remainingPercent(g.usage), 96);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
