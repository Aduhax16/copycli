// Antigravity, driven through `agy -p --output-format stream-json`.
// Headless agy never prompts: actions its mode does not allow are refused, not asked.
import path from 'node:path';
import { spawnJsonl } from './proc.js';
import { isLimitError } from '../limits.js';

export function agyArgs({ prompt, cwd, mode, model, sessionId }) {
  const a = ['-p', prompt, '--output-format', 'stream-json', '--add-dir', cwd];
  if (mode === 'plan') a.push('--mode', 'plan');
  else if (mode === 'edit') a.push('--mode', 'accept-edits');
  else if (mode === 'full') a.push('--dangerously-skip-permissions');
  if (model) a.push('--model', model);
  if (sessionId) a.push('--conversation', sessionId);
  return a;
}

export class AntigravityDriver {
  constructor(opts) { this.o = opts; }
  run({ prompt, cwd, mode, model, sessionId, instructions, mcp, onEvent, signal }) {
    return new Promise((resolve) => {
      let sid = sessionId, out, sawText = false, lastStep;
      const p = spawnJsonl(this.o.path, agyArgs({ prompt: `${instructions}\n\n${prompt}`, cwd, mode, model, sessionId }), {
        cwd, env: { ...this.o.env, COPYCLI_MCP_URL: mcp.url, COPYCLI_MCP_TOKEN: mcp.token },
        onJson: (m) => {
          const id = m.conversation_id || m.step_update?.conversation_id || m.result?.conversation_id;
          if (id && id !== sid) { sid = id; onEvent({ type: 'session', id }); }
          const s = m.step_update;
          if (m.event === 'step_update' && s) {
            if (s.text_delta && s.step_type === 'agent_response') {
              if (lastStep !== s.step_index) { lastStep = s.step_index; onEvent({ type: 'break' }); }
              sawText = true;
              onEvent({ type: 'text', delta: s.text_delta });
            }
            if (s.step_type === 'tool') {
              const par = s.tool_info?.parameters || {};
              const file = par.TargetFile || par.AbsolutePath || par.path;
              onEvent({ type: 'tool', id: `s${s.step_index}`, name: s.tool_name || s.tool_info?.name || 'Tool', detail: par.CommandLine || file || (Object.keys(par).length ? JSON.stringify(par).slice(0, 300) : ''),
                status: s.tool_info?.error ? 'error' : s.state === 'DONE' ? 'done' : 'running', output: String(s.tool_info?.error?.message || s.tool_info?.output || '').slice(0, 4000) });
              if (file && s.state === 'DONE' && !s.tool_info?.error && /write|edit|replace|create/i.test(s.tool_name || '')) onEvent({ type: 'files', paths: [path.resolve(cwd, file)] });
            }
          } else if (m.event === 'result') {
            const r = m.result || {};
            if (r.status === 'SUCCESS') { if (!sawText && r.response) onEvent({ type: 'text', delta: r.response }); out = { status: 'done' }; }
            else { const e = typeof r.error === 'string' ? r.error : r.error?.message || r.status || 'Antigravity stopped with an error'; out = { status: isLimitError(e) ? 'limit' : 'error', error: e }; }
          }
        },
        onExit: ({ code, stderr, error }) => {
          signal.removeEventListener('abort', stop);
          if (signal.aborted) return resolve({ status: 'cancelled', sessionId: sid });
          const msg = error?.message || stderr.trim() || `Antigravity exited (${code})`;
          resolve({ sessionId: sid, ...(out || { status: isLimitError(msg) ? 'limit' : 'error', error: msg }) });
        },
      });
      const stop = () => p.kill();
      signal.addEventListener('abort', stop);
      if (signal.aborted) stop(); else p.end();
    });
  }
  dispose() {}
}
