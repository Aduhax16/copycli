import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// Spawn a child that speaks newline-delimited JSON.
export function spawnJsonl(cmd, args, { cwd, env, onJson, onExit }) {
  const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  const dec = new StringDecoder('utf8');
  let buf = '', stderr = '', done = false;
  const line = (l) => {
    l = l.trim();
    if (!l) return;
    let j;
    try { j = JSON.parse(l); } catch { stderr = (stderr + l + '\n').slice(-8000); return; }
    if (j && typeof j === 'object') try { onJson(j); } catch (e) { console.error('agent event failed', e); }
  };
  child.stdout.on('data', (d) => {
    buf += dec.write(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
  child.stdin.on('error', () => {});
  const finish = (code, err) => { if (done) return; done = true; if (buf) line(buf); onExit?.({ code, stderr, error: err }); };
  child.on('error', (e) => finish(null, e));
  child.on('close', (code) => finish(code));
  return {
    get alive() { return !done; },
    get stderr() { return stderr; },
    send: (o) => { if (!done && child.stdin.writable) child.stdin.write(JSON.stringify(o) + '\n'); },
    end: () => child.stdin.end(),
    kill: () => {
      if (done || !child.pid) return;
      const sig = (s) => { try { process.platform === 'win32' ? child.kill(s) : process.kill(-child.pid, s); } catch {} };
      sig('SIGTERM');
      setTimeout(() => { if (!done) sig('SIGKILL'); }, 3000).unref();
    },
  };
}

// JSON-RPC 2.0 over JSONL. Incoming requests go to onRequest, notifications to onNotify.
export function spawnRpc(cmd, args, { cwd, env, onRequest, onNotify, onExit }) {
  let next = 1;
  const pending = new Map();
  const p = spawnJsonl(cmd, args, {
    cwd, env,
    onJson: async (m) => {
      if (m.method && m.id !== undefined) {
        try { p.send({ jsonrpc: '2.0', id: m.id, result: await onRequest(m.method, m.params || {}) }); }
        catch (e) { p.send({ jsonrpc: '2.0', id: m.id, error: { code: e.code || -32603, message: e.message } }); }
      } else if (m.method) onNotify(m.method, m.params || {});
      else if (pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) reject(Object.assign(new Error(m.error.message || 'Agent error'), { data: m.error.data, code: m.error.code }));
        else resolve(m.result);
      }
    },
    onExit: (x) => {
      const e = new Error(x.error?.message || x.stderr.trim().split('\n').slice(-4).join('\n') || `Agent exited (${x.code})`);
      for (const { reject } of pending.values()) reject(e);
      pending.clear();
      onExit?.(e);
    },
  });
  return {
    get alive() { return p.alive; },
    kill: p.kill,
    request: (method, params) => new Promise((resolve, reject) => {
      if (!p.alive) return reject(new Error('Agent is not running'));
      const id = next++;
      pending.set(id, { resolve, reject });
      p.send({ jsonrpc: '2.0', id, method, params });
    }),
    notify: (method, params) => p.send({ jsonrpc: '2.0', method, params }),
  };
}
