// A tiny ACP agent for tests. FAKE_MODE=limit makes it run out of usage.
import readline from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const mode = process.env.FAKE_MODE;
let perm;
readline.createInterface({ input: process.stdin }).on('line', async (l) => {
  const m = JSON.parse(l);
  const up = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } } });
  if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
  if (m.id === 'p1' && m.result) perm(m.result.outcome);
  if (m.method === 'session/prompt') {
    if (mode === 'limit') { up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Half done.' } }); return send({ id: m.id, error: { code: -32000, message: 'You have reached your usage limit' } }); }
    if (mode === 'ask') {
      send({ id: 'p1', method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 'c1', title: 'Run ls' }, options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] } });
      const o = await new Promise((r) => { perm = r; });
      up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission ${o.optionId}` } });
    } else {
      up({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Write', kind: 'edit', status: 'pending', locations: [{ path: 'a.txt' }] });
      up({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
      up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `GOT:${m.params.prompt[0].text}` } });
    }
    send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
});
