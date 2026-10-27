// Boots server.mjs with the fake engine (like server.test.mjs) and covers the M4 routes.
// Skills, attachments, git, and pending approval counts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'server.mjs');

const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-m4-skills-'));
fs.mkdirSync(path.join(skillDir, 'demo'));
fs.writeFileSync(
  path.join(skillDir, 'demo', 'SKILL.md'),
  '---\nname: demo\ndescription: Demo skill\n---\n\nSay DEMO-MARKER when used.\n'
);

after(() => {
  fs.rmSync(skillDir, { recursive: true, force: true });
});

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// An OS-assigned port, so this file never collides with server.test.mjs's random range.
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function bootServer({ env = {}, setup } = {}) {
  const chosenPort = await freePort();
  const fixture = makeFixture();
  if (setup) setup(fixture);
  const chosenDataDir = fixture.dataDir;
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      ...fixture.env,
      KEELVANE_PORT: String(chosenPort),
      KEELVANE_FAKE_ENGINE: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${chosenPort}`;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 8000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => reject(new Error(`server exited early with code ${code}: ${stderr.slice(0, 500)}`)));
  });
  return {
    base,
    dataDir: chosenDataDir,
    fixture,
    async stop() {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
      fixture.cleanup();
    },
  };
}

function openSse(url, timeoutMs = 20000) {
  const events = [];
  let buf = '';
  let settled = false;
  let resolveReady = null;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const u = new URL(url);
  const done = new Promise((resolve, reject) => {
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (resolveReady && buf.includes(': connected\n\n')) {
          const fire = resolveReady;
          resolveReady = null;
          fire();
        }
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (line) events.push(JSON.parse(line.slice(6)));
        }
        if (events.some((e) => e.type === 'turn_finished')) {
          settled = true;
          req.destroy();
          resolve(events);
        }
      });
      res.on('end', () => {
        if (!settled) {
          settled = true;
          resolve(events);
        }
      });
    });
    req.on('error', (err) => {
      if (!settled && !err.message.includes('socket hang up')) {
        settled = true;
        reject(err);
      }
    });
    req.setTimeout(timeoutMs, () => {
      if (!settled) {
        settled = true;
        req.destroy();
        reject(
          new Error(`timed out waiting for events on ${u.pathname}; got so far: ${events.map((e) => e.type).join(',')}`)
        );
      }
    });
  });
  return { ready, done, events };
}

async function createSession(base, project = 'alpha') {
  const res = await request(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Keelvane-Action': 'confirmed' },
    body: JSON.stringify({ project, engine: 'claude', model: 'haiku' }),
  });
  assert.equal(res.status, 200);
  const { session } = JSON.parse(res.body);
  assert.ok(session.id);
  return session;
}

async function postApproval(base, sessionId, approvalId, decision) {
  return request(`${base}/api/sessions/${sessionId}/approvals/${approvalId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Keelvane-Action': 'confirmed' },
    body: JSON.stringify({ decision }),
  });
}

function waitForEvent(events, type, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = events.find((e) => e.type === type);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out waiting for ${type}; got: ${events.map((e) => e.type).join(',')}`));
      }
      setTimeout(check, 25);
    };
    check();
  });
}

function postJson(base, route, body, confirmed = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (confirmed) headers['X-Keelvane-Action'] = 'confirmed';
  return request(`${base}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function skillEnv() {
  return { KEELVANE_SKILL_ROOTS: JSON.stringify([{ source: 'claude', dir: skillDir, flat: false }]) };
}

test('GET /api/skills returns the demo skill', async () => {
  const server = await bootServer({ env: skillEnv() });
  try {
    const res = await request(`${server.base}/api/skills`);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.skills.length, 1);
    assert.deepEqual(body.skills[0], {
      name: 'demo',
      description: 'Demo skill',
      source: 'claude',
      unsupported: null,
    });
    assert.ok(!('path' in body.skills[0]));
  } finally {
    await server.stop();
  }
});

test('attachments upload, sanitize, and validate', async () => {
  const server = await bootServer({ env: skillEnv() });
  try {
    const session = await createSession(server.base);
    const id = session.id;

    const noHeader = await request(`${server.base}/api/sessions/${id}/attachments?name=notes.txt`, {
      method: 'POST',
      body: 'hello attachment',
    });
    assert.equal(noHeader.status, 403);

    const okRes = await request(`${server.base}/api/sessions/${id}/attachments?name=notes.txt`, {
      method: 'POST',
      headers: { 'X-Keelvane-Action': 'confirmed' },
      body: 'hello attachment',
    });
    assert.equal(okRes.status, 200);
    const okBody = JSON.parse(okRes.body);
    assert.equal(okBody.ok, true);
    assert.equal(okBody.name, 'notes.txt');
    assert.equal(okBody.size, 16);
    const sessionFolder = path.join(server.dataDir, 'attachments', id);
    const normalizedSaved = path.resolve(okBody.path).toLowerCase();
    const normalizedFolder = path.resolve(sessionFolder).toLowerCase();
    assert.ok(normalizedSaved.startsWith(normalizedFolder + path.sep));
    assert.equal(fs.readFileSync(okBody.path, 'utf8'), 'hello attachment');

    const evilRes = await request(`${server.base}/api/sessions/${id}/attachments?name=${encodeURIComponent('../../evil.txt')}`, {
      method: 'POST',
      headers: { 'X-Keelvane-Action': 'confirmed' },
      body: 'evil',
    });
    assert.equal(evilRes.status, 200);
    const evilBody = JSON.parse(evilRes.body);
    assert.equal(evilBody.name, 'evil.txt');
    assert.ok(path.resolve(evilBody.path).toLowerCase().startsWith(normalizedFolder + path.sep));

    const secretRes = await request(`${server.base}/api/sessions/${id}/attachments?name=secrets.txt`, {
      method: 'POST',
      headers: { 'X-Keelvane-Action': 'confirmed' },
      body: 'secret',
    });
    assert.equal(secretRes.status, 400);

    const emptyRes = await request(`${server.base}/api/sessions/${id}/attachments?name=empty.txt`, {
      method: 'POST',
      headers: { 'X-Keelvane-Action': 'confirmed' },
      body: '',
    });
    assert.equal(emptyRes.status, 400);

    const bigName = 'big.bin';
    const bigBody = Buffer.alloc(20 * 1024 * 1024 + 1, 1);
    const bigRes = await request(`${server.base}/api/sessions/${id}/attachments?name=${bigName}`, {
      method: 'POST',
      headers: { 'X-Keelvane-Action': 'confirmed' },
      body: bigBody,
    });
    assert.equal(bigRes.status, 413);
    const remaining = fs.readdirSync(sessionFolder).filter((f) => f.endsWith(bigName));
    assert.equal(remaining.length, 0);

    const unknownRes = await request(`${server.base}/api/sessions/nope/attachments?name=x.txt`, {
      method: 'POST',
      headers: { 'X-Keelvane-Action': 'confirmed' },
      body: 'x',
    });
    assert.equal(unknownRes.status, 404);
  } finally {
    await server.stop();
  }
});

test('message with skill and attachment reaches the engine', async () => {
  const server = await bootServer({ env: skillEnv() });
  try {
    const session = await createSession(server.base);
    const id = session.id;

    const uploadRes = await request(`${server.base}/api/sessions/${id}/attachments?name=notes.txt`, {
      method: 'POST',
      headers: { 'X-Keelvane-Action': 'confirmed' },
      body: 'hello attachment',
    });
    assert.equal(uploadRes.status, 200);
    const upload = JSON.parse(uploadRes.body);

    const sse = openSse(`${server.base}/api/sessions/${id}/events`);
    await sse.ready;

    const msgRes = await postJson(server.base, `/api/sessions/${id}/messages`, {
      text: 'summarize it',
      skill: 'demo',
      attachments: [{ name: 'notes.txt', path: upload.path }],
    });
    assert.equal(msgRes.status, 202);

    const events = await sse.done;
    const userMessage = events.find((e) => e.type === 'user_message');
    assert.ok(userMessage);
    assert.equal(userMessage.payload.text, 'summarize it');
    assert.equal(userMessage.payload.skill, 'demo');
    assert.equal(userMessage.payload.attachments.length, 1);
    assert.equal(userMessage.payload.attachments[0].path, upload.path);
    assert.equal(userMessage.payload.attachments[0].size, 16);

    const deltas = events.filter((e) => e.type === 'text_delta').map((e) => e.payload.text).join('');
    assert.ok(deltas.includes('<skill name="demo">'));
    assert.ok(deltas.includes('DEMO-MARKER'));
    assert.ok(deltas.includes('summarize it'));
    assert.ok(deltas.includes('Attached files (read them with read_file):'));
    assert.ok(deltas.includes(upload.path.replace(/\\/g, '/')));
  } finally {
    await server.stop();
  }
});

test('message validation rejects bad skill and attachment paths', async () => {
  const server = await bootServer({ env: skillEnv() });
  try {
    const session = await createSession(server.base);
    const id = session.id;

    const unknownSkill = await postJson(server.base, `/api/sessions/${id}/messages`, {
      text: 'hi',
      skill: 'nope',
    });
    assert.equal(unknownSkill.status, 400);

    const outsidePath = await postJson(server.base, `/api/sessions/${id}/messages`, {
      text: 'hi',
      attachments: [{ name: 'server.mjs', path: SERVER }],
    });
    assert.equal(outsidePath.status, 400);

    const other = await createSession(server.base);
    const otherUpload = await request(`${server.base}/api/sessions/${other.id}/attachments?name=other.txt`, {
      method: 'POST',
      headers: { 'X-Keelvane-Action': 'confirmed' },
      body: 'other',
    });
    assert.equal(otherUpload.status, 200);
    const otherPath = JSON.parse(otherUpload.body).path;
    const crossSession = await postJson(server.base, `/api/sessions/${id}/messages`, {
      text: 'hi',
      attachments: [{ name: 'other.txt', path: otherPath }],
    });
    assert.equal(crossSession.status, 400);

    const manyAttachments = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, path: path.join(server.dataDir, 'attachments', id, `f${i}.txt`) }));
    const tooMany = await postJson(server.base, `/api/sessions/${id}/messages`, {
      text: 'hi',
      attachments: manyAttachments,
    });
    assert.equal(tooMany.status, 400);

    const emptyAll = await postJson(server.base, `/api/sessions/${id}/messages`, {
      text: '',
    });
    assert.equal(emptyAll.status, 400);

    const skillOnly = await postJson(server.base, `/api/sessions/${id}/messages`, {
      text: '',
      skill: 'demo',
    });
    assert.equal(skillOnly.status, 202);
  } finally {
    await server.stop();
  }
});

test('plain text still reaches the engine unchanged', async () => {
  const server = await bootServer({ env: skillEnv() });
  try {
    const session = await createSession(server.base);
    const sse = openSse(`${server.base}/api/sessions/${session.id}/events`);
    await sse.ready;
    const res = await postJson(server.base, `/api/sessions/${session.id}/messages`, { text: 'hello plain' });
    assert.equal(res.status, 202);
    const events = await sse.done;
    const deltas = events.filter((e) => e.type === 'text_delta').map((e) => e.payload.text).join('');
    assert.ok(deltas.includes('You asked: "hello plain"'));
  } finally {
    await server.stop();
  }
});

test('pending approvals count appears in session list', async () => {
  const server = await bootServer({ env: skillEnv() });
  try {
    const session = await createSession(server.base);
    const other = await createSession(server.base);
    const sse = openSse(`${server.base}/api/sessions/${session.id}/events`);
    await sse.ready;

    const res = await postJson(server.base, `/api/sessions/${session.id}/messages`, {
      text: 'tool {"tool":"run_command","args":{"command":"echo hi"}}',
    });
    assert.equal(res.status, 202);

    const approval = await waitForEvent(sse.events, 'approval_requested');
    const listRes = await request(`${server.base}/api/sessions`);
    assert.equal(listRes.status, 200);
    const list = JSON.parse(listRes.body);
    const target = list.sessions.find((s) => s.id === session.id);
    const fresh = list.sessions.find((s) => s.id === other.id);
    assert.equal(target.pending_approvals, 1);
    assert.equal(fresh.pending_approvals, 0);

    const denyRes = await postApproval(server.base, session.id, approval.payload.approval_id, 'deny');
    assert.equal(denyRes.status, 200);
    await sse.done;

    const afterRes = await request(`${server.base}/api/sessions`);
    const afterList = JSON.parse(afterRes.body);
    const afterTarget = afterList.sessions.find((s) => s.id === session.id);
    assert.equal(afterTarget.pending_approvals, 0);
  } finally {
    await server.stop();
  }
});

// The fixture root becomes a git repo (baseline commit) so alpha is a sub-scope and bravo lies outside it.
function initRepo(fixture) {
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { cwd: fixture.root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  fs.writeFileSync(path.join(fixture.alpha, 'changed.md'), 'new file\n');
  fs.writeFileSync(path.join(fixture.alpha, '.env'), 'KEY=value\n');
  fs.writeFileSync(path.join(fixture.bravo, 'other.md'), 'other project file\n');
  return git;
}

test('git routes are read-only and validate scope', async () => {
  let git;
  const server = await bootServer({ env: skillEnv(), setup: (fixture) => { git = initRepo(fixture); } });
  try {
    const session = await createSession(server.base, 'alpha');
    const id = session.id;

    const statusRes = await request(`${server.base}/api/sessions/${id}/git`);
    assert.equal(statusRes.status, 200);
    const status = JSON.parse(statusRes.body);
    assert.equal(status.ok, true);
    assert.equal(status.scope, 'alpha');
    assert.ok(Array.isArray(status.files));
    assert.ok(status.files.some((f) => f.path === 'alpha/changed.md'));
    assert.ok(!status.files.some((f) => f.path.startsWith('bravo/')));
    assert.equal(typeof status.truncated, 'boolean');

    const traversal = await request(`${server.base}/api/sessions/${id}/git/diff?path=..%2Fx`);
    assert.equal(traversal.status, 400);

    const outside = await request(
      `${server.base}/api/sessions/${id}/git/diff?path=${encodeURIComponent('bravo/other.md')}`
    );
    assert.equal(outside.status, 400);

    const headBefore = git('rev-parse', 'HEAD');
    const noHeader = await request(`${server.base}/api/sessions/${id}/git/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x', paths: [] }),
    });
    assert.equal(noHeader.status, 403);

    const emptyPaths = await postJson(server.base, `/api/sessions/${id}/git/commit`, { message: 'x', paths: [] });
    assert.equal(emptyPaths.status, 400);

    const emptyMessage = await postJson(server.base, `/api/sessions/${id}/git/commit`, {
      message: '',
      paths: ['alpha/changed.md'],
    });
    assert.equal(emptyMessage.status, 400);

    const outsidePath = await postJson(server.base, `/api/sessions/${id}/git/commit`, {
      message: 'x',
      paths: ['bravo/other.md'],
    });
    assert.equal(outsidePath.status, 400);

    const protectedPath = await postJson(server.base, `/api/sessions/${id}/git/commit`, {
      message: 'x',
      paths: ['alpha/.env'],
    });
    assert.equal(protectedPath.status, 400);

    assert.equal(headBefore, git('rev-parse', 'HEAD'));
  } finally {
    await server.stop();
  }
});
