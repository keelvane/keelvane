// Health check. Read-only on the install: the loopback test runs a throwaway copy of the server on spare ports
// with a temp data folder, a throwaway token and the fake engine, so it never touches real projects or the ledger.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validateConfig } from '../config.mjs';
import { layout, CRED_TARGET, TASK_NAME, SERVE_PORT } from './system.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function request(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    if (body !== undefined) { req.setHeader('Content-Type', 'application/json'); req.write(JSON.stringify(body)); }
    req.end();
  });
}

// One ask and read through the real connector gate against the fake engine, then an exact retry.
export async function loopbackCheck({ config, sys, appDir = PKG }) {
  const project = config.projects.find((p) => p.muse);
  if (!project) return { status: 'warn', detail: 'no project is exposed to Muse; nothing to test' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-doctor-'));
  let child;
  try {
    let uiPort = 48100;
    for (; uiPort < 48400; uiPort += 2) if (await sys.isPortFree(uiPort) && await sys.isPortFree(uiPort + 1)) break;
    const token = `doctor-${process.pid}-${Date.now()}`;
    const capability = 'doctor.test/cap/keelvane-doctor';
    const host = 'doctor.test.ts.net';
    const projDir = path.join(dir, 'project');
    fs.mkdirSync(projDir);
    const temp = {
      schema: 1, dataDir: path.join(dir, 'data'), ports: { ui: uiPort, connector: uiPort + 1 },
      projects: [{ code: project.code, name: project.name, path: projDir, engine: 'claude', private: false, muse: { read: [], withhold: [], inbox: 'Muse-Inbox' } }],
      connector: { enabled: true, capability, serveHost: host, tokenSha256: sha256(token), maxBodyBytes: config.connector.maxBodyBytes },
    };
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(temp));
    child = spawn(process.execPath, [path.join(appDir, 'server.mjs')], {
      env: { ...process.env, KEELVANE_CONFIG: file, KEELVANE_DATA: temp.dataDir, KEELVANE_FAKE_ENGINE: '1', KEELVANE_PORT: String(uiPort), KEELVANE_CONNECTOR_PORT: String(uiPort + 1) },
      stdio: 'ignore', windowsHide: true,
    });
    const headers = { Host: `${host}:${SERVE_PORT}`, 'Tailscale-App-Capabilities': JSON.stringify({ [capability]: [{}] }), Authorization: `Bearer ${token}` };
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try { ready = (await request(uiPort + 1, { url: '/muse/v1/status', headers })).status === 200; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    if (!ready) return { status: 'fail', detail: 'the test server did not start within 20 seconds' };
    const body = { chat_id: 'doctor', request_id: 'doctor-1', project: project.code, text: 'ping' };
    const first = await request(uiPort + 1, { method: 'POST', url: '/muse/v1/chats/ask', headers, body });
    if (first.status !== 202) return { status: 'fail', detail: `ask returned ${first.status}` };
    let result;
    while (Date.now() < deadline) {
      result = await request(uiPort + 1, { url: '/muse/v1/chats/read?chat_id=doctor&request_id=doctor-1', headers });
      if (result.json && result.json.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (result?.json?.status !== 'idle') return { status: 'fail', detail: `read ended as ${result?.json?.status || 'no answer'}` };
    const retry = await request(uiPort + 1, { method: 'POST', url: '/muse/v1/chats/ask', headers, body });
    if (retry.status !== 200) return { status: 'fail', detail: `exact retry returned ${retry.status}, expected 200` };
    return { status: 'ok', detail: 'ask, read and exact retry passed against the fake engine' };
  } catch (error) {
    return { status: 'fail', detail: error.message };
  } finally {
    if (child) { child.kill(); await new Promise((r) => setTimeout(r, 200)); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function runDoctor({ root, sys, appDir = PKG, config: given, loopback = true }) {
  const L = layout(root);
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  let config = given;
  if (!config) {
    if (!fs.existsSync(L.config)) {
      add('config', 'fail', `${L.config} not found; run setup`);
      return summarize(checks);
    }
    let raw;
    try { raw = JSON.parse(fs.readFileSync(L.config, 'utf8')); } catch (error) {
      add('config', 'fail', `not valid JSON: ${error.message}`);
      return summarize(checks);
    }
    const checked = validateConfig(raw);
    if (checked.errors.length) {
      for (const e of checked.errors) add('config', 'fail', e);
      return summarize(checks);
    }
    config = checked.config;
  }
  add('config', 'ok', `schema ${config.schema}, ${config.projects.length} project(s)`);

  for (const [label, port] of [['ui', config.ports.ui], ['connector', config.ports.connector]]) {
    const up = await sys.portListening(port);
    // Same predicate as connectorReady in remote.mjs (not imported: remote.mjs loads config at import time).
    const c = config.connector || {};
    const off = label === 'connector' && !(c.enabled && c.capability && c.serveHost && /^[0-9a-f]{64}$/.test(c.tokenSha256));
    add(`port ${label}`, up ? 'ok' : 'warn', up ? `${port} is listening` : off ? `${port} is off until the connector and Tailscale are set up` : `${port} is not listening (service stopped?)`);
  }

  const used = new Set(config.projects.map((p) => p.engine));
  for (const name of ['claude', 'codex']) {
    const bin = sys.findBin(name, config.engines[name].bin);
    if (!bin) add(`engine ${name}`, used.has(name) ? 'fail' : 'warn', `${name} not found${used.has(name) ? ' but a project uses it' : ''}`);
    else add(`engine ${name}`, 'ok', `${bin} (${sys.binVersion(bin) || 'version unknown'})`);
  }

  for (const p of config.projects) {
    if (!fs.existsSync(p.path) || !fs.statSync(p.path).isDirectory()) { add(`project ${p.code}`, 'fail', `${p.path} is not a folder`); continue; }
    const git = sys.gitState(p.path);
    add(`project ${p.code}`, git.repo ? 'ok' : 'warn', git.repo ? `${p.path}${git.dirty ? ' (uncommitted changes)' : ''}` : `${p.path} is not a Git repo; changes are not tracked`);
  }

  if (config.connector.enabled) {
    const stored = await sys.cred.get(CRED_TARGET);
    if (!stored) add('token', 'fail', 'connector token not found in Credential Manager; rerun setup');
    else if (sha256(stored.trim()) !== config.connector.tokenSha256) add('token', 'fail', 'stored token does not match the config hash; rerun setup');
    else add('token', 'ok', 'present in Credential Manager and matches the config hash');
    if (config.connector.serveHost) {
      const status = await sys.tailscale.serveStatus();
      const ok = status.includes(String(config.ports.connector));
      add('tailscale serve', ok ? 'ok' : 'warn', ok ? `port ${SERVE_PORT} forwards to the connector` : 'no serve rule points at the connector port');
    } else add('tailscale serve', 'warn', 'not configured; Muse cannot reach this machine yet');
  } else add('connector', 'ok', 'disabled');

  const task = await sys.task.has(TASK_NAME);
  add('autostart', task ? 'ok' : 'warn', task ? 'logon task registered' : 'no logon task; the service will not start at sign-in');

  if (loopback && config.connector.enabled) {
    const r = await loopbackCheck({ config, sys, appDir });
    add('loopback', r.status, r.detail);
  }
  return summarize(checks);
}

function summarize(checks) {
  const overall = checks.some((c) => c.status === 'fail') ? 'red' : checks.some((c) => c.status === 'warn') ? 'yellow' : 'green';
  return { overall, checks };
}

export function formatDoctor(result) {
  const mark = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  return [...result.checks.map((c) => `${mark[c.status]} ${c.name}: ${c.detail}`), `Overall: ${result.overall.toUpperCase()}`].join('\n');
}
