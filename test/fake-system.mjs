// In-memory stand-in for setup/system.mjs: no Credential Manager, task scheduler, Tailscale, clipboard or
// child process is ever touched. Every effect is recorded in `calls` so tests can assert on it.
import fs from 'node:fs';
import path from 'node:path';

export function makeFakeSystem(over = {}) {
  const calls = [];
  const rec = (name, arg) => calls.push({ name, arg });
  const creds = new Map();
  const tasks = new Set();
  const state = { serve: false, listening: new Set(), clipboard: null, tailscale: { ok: true, serveHost: 'keelvane-test.tail0000.ts.net', tailnetIp: '10.0.0.9', peers: [] } };
  const sys = {
    dryRun: false,
    calls, creds, tasks, state,
    osRelease: () => 'Windows_NT 10.0.test',
    isPortFree: async (port) => !state.listening.has(port) && !(over.busyPorts || []).includes(port),
    portListening: async (port) => state.listening.has(port),
    findBin: (name) => (over.noEngines ? null : `C:/fake/${name}.exe`),
    binVersion: () => '9.9.9',
    liveCheck: (name) => { rec('liveCheck', name); return { ok: true, detail: 'ok' }; },
    cred: {
      has: async (t) => creds.has(t),
      get: async (t) => creds.get(t) ?? null,
      set: async (t, v) => { rec('cred.set', t); creds.set(t, v); },
      del: async (t) => { rec('cred.del', t); creds.delete(t); },
    },
    task: {
      has: async (n) => tasks.has(n),
      create: async (s) => { rec('task.create', s); tasks.add(s.name); },
      remove: async (n) => { rec('task.remove', n); tasks.delete(n); },
    },
    tailscale: {
      status: async () => state.tailscale,
      serveStatus: async () => (state.serve ? `https://x:8443 proxy http://127.0.0.1:${state.servePort}` : ''),
      serve: async (s) => { rec('tailscale.serve', s); state.serve = true; state.servePort = s.connectorPort; },
      unserve: async () => { rec('tailscale.unserve'); state.serve = false; },
    },
    clipboard: async (t) => { rec('clipboard'); state.clipboard = t; },
    gitInit: (d) => { rec('gitInit', d); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); },
    gitState: (d) => (fs.existsSync(path.join(d, '.git')) ? { repo: true, dirty: false } : { repo: false, dirty: null }),
    startService: (s) => { rec('startService', s); },
    stopService: (s) => { rec('stopService', s); },
    openUrl: (u) => { rec('openUrl', u); },
    zip: (src, dest) => { rec('zip', dest); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, JSON.stringify(fs.readdirSync(src))); },
  };
  return sys;
}
