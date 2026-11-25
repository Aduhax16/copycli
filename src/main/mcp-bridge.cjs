// stdio ↔ HTTP bridge for agents that only take stdio MCP servers.
// Outside Relaydeck (no URL in the environment) it offers no tools.
const url = process.env.RELAYDECK_MCP_URL, token = process.env.RELAYDECK_MCP_TOKEN;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
async function handle(m) {
  if (!url) {
    if (m.id === undefined) return;
    const r = { initialize: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'relaydeck', version: '0' } }, 'tools/list': { tools: [] }, ping: {} }[m.method];
    return out(r ? { jsonrpc: '2.0', id: m.id, result: r } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Relaydeck is not running' } });
  }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(m) });
    if (m.id === undefined) return;
    if (!res.ok) throw new Error(`Relaydeck answered ${res.status}`);
    out(await res.json());
  } catch (e) { if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } }); }
}
let buf = '', open = 0, ended = false;
const done = () => { if (ended && !open) process.exit(0); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!l) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; }
    open++;
    handle(m).finally(() => { open--; done(); });
  }
});
process.stdin.on('end', () => { ended = true; done(); });
