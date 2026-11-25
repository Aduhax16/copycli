// A small MCP server on localhost. Every agent gets its own token, so each call is attributed.
import http from 'node:http';
import { randomBytes } from 'node:crypto';

export class McpServer {
  constructor({ tools, call, version }) { Object.assign(this, { tools, call, version }); this.tokens = new Map(); }
  async listen() {
    this.server = http.createServer((q, s) => this.handle(q, s).catch(() => { if (!s.headersSent) s.writeHead(500); s.end(); }));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
    this.url = `http://127.0.0.1:${this.port}/mcp`;
  }
  tokenFor(who) {
    for (const [t, w] of this.tokens) if (w.chatId === who.chatId && w.agentId === who.agentId) return t;
    const t = randomBytes(24).toString('hex');
    this.tokens.set(t, who);
    return t;
  }
  async handle(req, res) {
    // Loopback host only, and nothing from a web page.
    if (req.headers.host !== `127.0.0.1:${this.port}` || req.headers.origin) { res.writeHead(403).end(); return; }
    const who = this.tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!who) { res.writeHead(401).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    let body = '';
    for await (const c of req) { body += c; if (body.length > 4e6) { res.writeHead(413).end(); return; } }
    let m;
    try { m = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    if (m?.id === undefined) { res.writeHead(202).end(); return; }
    const reply = { jsonrpc: '2.0', id: m.id };
    try { reply.result = await this.rpc(m, who); } catch (e) { reply.error = { code: e.code || -32603, message: e.message }; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
  }
  async rpc(m, who) {
    switch (m.method) {
      case 'initialize': return { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'copycli', version: this.version } };
      case 'ping': return {};
      case 'tools/list': return { tools: this.tools };
      case 'tools/call':
        try {
          const r = await this.call(who, m.params?.name, m.params?.arguments || {});
          return { content: Array.isArray(r) ? r : [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 1) }] };
        } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
      default: throw Object.assign(new Error('Method not found'), { code: -32601 });
    }
  }
}
