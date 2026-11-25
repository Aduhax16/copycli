// Claude Code, driven through its own CLI in stream-json mode.
import { randomUUID } from 'node:crypto';
import { spawnJsonl } from './proc.js';
import { isLimitError } from '../limits.js';

const MODES = { plan: 'plan', ask: 'manual', edit: 'acceptEdits', full: 'bypassPermissions' };
const short = (v, n = 4000) => (v.length > n ? v.slice(0, n) + '\n…' : v);

export function claudeToolDetail(name, input = {}) {
  return input.command || input.file_path || input.notebook_path || input.pattern || input.url || input.query || input.description || (Object.keys(input).length ? JSON.stringify(input).slice(0, 300) : '');
}

export class ClaudeDriver {
  constructor(opts) { this.o = opts; }

  run({ prompt, cwd, mode, model, sessionId, instructions, mcp, onEvent, onApproval, signal }) {
    return new Promise((resolve) => {
      const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--permission-prompt-tool', 'stdio', '--permission-mode', MODES[mode] || 'manual', '--disallowedTools', 'AskUserQuestion',
        '--append-system-prompt', instructions,
        '--mcp-config', JSON.stringify({ mcpServers: { relaydeck: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }),
        '--allowedTools', 'mcp__relaydeck'];
      if (mode === 'full') args.push('--allow-dangerously-skip-permissions');
      if (model) args.push('--model', model);
      if (sessionId) args.push('--resume', sessionId);
      let sid = sessionId, out, rate, sawText = false;
      const tools = new Map();

      const p = spawnJsonl(this.o.path, args, {
        cwd, env: { ...this.o.env, CLAUDE_CODE_ENTRYPOINT: 'relaydeck' },
        onJson: async (m) => {
          if (m.session_id && m.session_id !== sid) { sid = m.session_id; onEvent({ type: 'session', id: sid }); }
          if (m.parent_tool_use_id) return;
          if (m.type === 'stream_event') {
            const e = m.event;
            if (e?.type === 'content_block_start' && e.content_block?.type === 'text') onEvent({ type: 'break' });
            if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') { sawText = true; onEvent({ type: 'text', delta: e.delta.text }); }
          } else if (m.type === 'assistant') {
            for (const b of m.message?.content || []) {
              if (b.type === 'tool_use') {
                tools.set(b.id, b);
                onEvent({ type: 'tool', id: b.id, name: b.name, detail: claudeToolDetail(b.name, b.input), status: 'running' });
                if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)) onEvent({ type: 'files', paths: [b.input.file_path || b.input.notebook_path].filter(Boolean) });
              }
            }
          } else if (m.type === 'user') {
            for (const b of Array.isArray(m.message?.content) ? m.message.content : []) if (b.type === 'tool_result') {
              const t = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || `[${c.type}]`).join('\n');
              onEvent({ type: 'tool', id: b.tool_use_id, status: b.is_error ? 'error' : 'done', output: short(t) });
            }
          } else if (m.type === 'rate_limit_event') {
            rate = m.rate_limit_info;
            onEvent({ type: 'limits', info: { status: rate?.status, resetsAt: rate?.resetsAt, kind: rate?.rateLimitType } });
          } else if (m.type === 'control_request') {
            const r = m.request || {};
            let response = {};
            if (r.subtype === 'can_use_tool') {
              const ok = await onApproval({ title: `Use ${r.tool_name}`, detail: claudeToolDetail(r.tool_name, r.input), toolId: r.tool_use_id, canAlways: !!r.permission_suggestions?.length });
              response = ok === 'deny' ? { behavior: 'deny', message: 'The user declined this.' }
                : { behavior: 'allow', updatedInput: r.input, ...(ok === 'always' ? { updatedPermissions: (r.permission_suggestions || []).map((s) => ({ ...s, destination: 'session' })) } : {}) };
            }
            p.send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
          } else if (m.type === 'result') {
            const text = m.result || (m.errors || []).join('\n');
            if (m.is_error || m.subtype !== 'success') {
              const limit = rate?.status === 'rejected' || m.api_error_status === 429 || isLimitError(text);
              out = { status: limit ? 'limit' : 'error', error: text || 'Claude stopped with an error', resetsAt: limit ? rate?.resetsAt : undefined };
            } else {
              if (!sawText && text) onEvent({ type: 'text', delta: text });
              out = { status: 'done' };
            }
            onEvent({ type: 'usage', input: m.usage?.input_tokens, output: m.usage?.output_tokens });
            p.end();
          }
        },
        onExit: ({ code, stderr, error }) => {
          signal.removeEventListener('abort', stop);
          if (signal.aborted) return resolve({ status: 'cancelled', sessionId: sid });
          const msg = error?.message || stderr.trim() || `Claude exited (${code})`;
          resolve({ sessionId: sid, ...(out || { status: isLimitError(msg) ? 'limit' : 'error', error: msg }) });
        },
      });
      const stop = () => {
        p.send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
        setTimeout(() => p.kill(), 1500).unref();
      };
      signal.addEventListener('abort', stop);
      if (signal.aborted) stop();
      p.send({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: sid || '' });
    });
  }
  dispose() {}
}
