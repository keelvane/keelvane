// Boots server.mjs as a real child process (fake engine) and drives the Muse connector over HTTP
// with the Host, capability and bearer headers a tailnet device would present.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveProject, museTurnText } from '../remote.mjs';
import { useFixture, makeFixture, TOKEN, CAPABILITY, SERVE_HOST } from './fixture.mjs';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = {};
const cleanups = [];
const randomPort = () => 30000 + Math.floor(Math.random() * 10000);

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method,
      headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== null && v !== undefined)),
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) {
      if (typeof body === 'string') req.write(body);
      else { req.setHeader('Content-Type', 'application/json'); req.write(JSON.stringify(body)); }
    }
    req.end();
  });
}

function muse(method, p, { headers = {}, body, token = TOKEN, port = state.connectorPort } = {}) {
  const all = { Host: `${SERVE_HOST}:8443`, 'Tailscale-App-Capabilities': JSON.stringify({ [CAPABILITY]: [{}] }), ...headers };
  if (token !== null) all.Authorization = `Bearer ${token}`;
  return request(port, { method, path: p, headers: all, body });
}

const ask = (chat, req, text, project = 'alpha') => muse('POST', '/muse/v1/chats/ask', {
  body: project === undefined ? { chat_id: chat, request_id: req, text } : { chat_id: chat, request_id: req, project, text },
});
const read = (chat, req) => muse('GET', `/muse/v1/chats/read?chat_id=${encodeURIComponent(chat)}&request_id=${encodeURIComponent(req)}`);

async function waitDone(chat, req, port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const r = await muse('GET', `/muse/v1/chats/read?chat_id=${chat}&request_id=${req}`, { port });
    if (r.json && r.json.status !== 'running') return r.json;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for the Muse request');
}

let seq = 0;
const uid = (p) => `${p}${process.pid}x${seq++}`;
async function askDone(text, project = 'alpha') {
  const chat = uid('c');
  const req = uid('r');
  const first = await ask(chat, req, text, project);
  assert.equal(first.status, 202, first.text);
  return waitDone(chat, req);
}
const tool = async (name, args) => (await askDone(`tool ${JSON.stringify({ tool: name, args })}`)).reply;

function boot(fixture, { connectorPort, uiPort = randomPort(), turnMs = '3000', waitFor }) {
  const child = spawn(process.execPath, [path.join(HARNESS, 'server.mjs')], {
    cwd: HARNESS,
    env: {
      ...process.env, ...fixture.env,
      KEELVANE_PORT: String(uiPort), KEELVANE_CONNECTOR_PORT: String(connectorPort),
      KEELVANE_FAKE_ENGINE: '1', KEELVANE_MUSE_TURN_MS: turnMs, KEELVANE_MUSE_MAX_STEPS: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start. Output:\n${output}`)); }, 15000);
    const check = () => {
      if (waitFor.every((line) => output.includes(line))) { clearTimeout(timer); resolve({ child, uiPort, output: () => output }); }
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code}). Output:\n${output}`)); });
  });
}

function stop(server) {
  return new Promise((resolve) => {
    if (server.child.exitCode !== null || server.child.signalCode !== null) return resolve();
    server.child.once('exit', () => resolve());
    server.child.kill();
  });
}

const ON = ['Keelvane Harness listening', 'Muse connector listening on'];

before(async () => {
  state.fixture = makeFixture();
  state.connectorPort = randomPort();
  state.server = await boot(state.fixture, { connectorPort: state.connectorPort, waitFor: ON });
  // In-process config for resolveProject, which reads the same fixture config.
  useFixture();
});

after(async () => {
  if (state.server) await stop(state.server);
  for (const fn of cleanups) await fn();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(state.fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Gating

test('openapi.json needs the host and capability but no bearer token', async () => {
  const r = await muse('GET', '/muse/v1/openapi.json', { token: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.openapi, '3.1.0');
  assert.match(JSON.stringify(r.json.paths), /askKeelvaneProjectChat/);
  assert.equal(r.json.servers[0].url, `https://${SERVE_HOST}:8443`);
});

test('missing or wrong bearer token gives 401 with WWW-Authenticate', async () => {
  for (const token of [null, 'wrong', '']) {
    const r = await muse('GET', '/muse/v1/projects', { token });
    assert.equal(r.status, 401, String(token));
    assert.match(r.headers['www-authenticate'] || '', /^Bearer/);
  }
  const bad = await request(state.connectorPort, {
    path: '/muse/v1/projects',
    headers: { Host: SERVE_HOST, 'Tailscale-App-Capabilities': JSON.stringify({ [CAPABILITY]: [{}] }), Authorization: `Basic ${TOKEN}` },
  });
  assert.equal(bad.status, 401);
});

test('the capability header is required, must name the capability and must hold an array', async () => {
  const cases = ['', 'not json', JSON.stringify({ 'example.test/cap/other': [{}] }), JSON.stringify({ [CAPABILITY]: 'yes' }), JSON.stringify([CAPABILITY])];
  for (const value of cases) {
    const r = await muse('GET', '/muse/v1/openapi.json', { headers: { 'Tailscale-App-Capabilities': value } });
    assert.equal(r.status, 403, value);
  }
  const none = await muse('GET', '/muse/v1/openapi.json', { headers: { 'Tailscale-App-Capabilities': null } });
  assert.equal(none.status, 403);
});

test('wrong Host gives 400; the bare host and the :8443 form are accepted', async () => {
  for (const host of [`127.0.0.1:${state.connectorPort}`, 'evil.example', `${SERVE_HOST}:443`]) {
    assert.equal((await muse('GET', '/muse/v1/projects', { headers: { Host: host } })).status, 400, host);
  }
  assert.equal((await muse('GET', '/muse/v1/projects', { headers: { Host: SERVE_HOST } })).status, 200);
  assert.equal((await muse('GET', '/muse/v1/projects', { headers: { Host: SERVE_HOST.toUpperCase() } })).status, 200);
});

test('a Tailscale user login or a funnel header gives 403', async () => {
  assert.equal((await muse('GET', '/muse/v1/projects', { headers: { 'Tailscale-User-Login': 'someone@example.test' } })).status, 403);
  assert.equal((await muse('GET', '/muse/v1/projects', { headers: { 'Tailscale-Funnel-Request': '?1' } })).status, 403);
});

test('app routes and the old single-chat routes are 404', async () => {
  const cases = [['GET', '/'], ['GET', '/api/sessions'], ['POST', '/api/tool'], ['GET', '/api/projects'], ['POST', '/muse/v1/ask'], ['GET', '/muse/v1/read'], ['GET', '/office']];
  for (const [method, p] of cases) {
    const r = await muse(method, p, { body: method === 'POST' ? {} : undefined });
    assert.equal(r.status, 404, `${method} ${p}`);
  }
});

test('connector disabled in config means no listener', async () => {
  const f = makeFixture();
  f.config.connector.enabled = false;
  fs.writeFileSync(f.configFile, JSON.stringify(f.config));
  const port = randomPort();
  const server = await boot(f, { connectorPort: port, waitFor: ['Keelvane Harness listening', 'Muse connector off'] });
  try {
    assert.ok(!server.output().includes('Muse connector listening'));
    await assert.rejects(request(port, { path: '/muse/v1/openapi.json' }), /ECONNREFUSED/);
  } finally {
    await stop(server);
    await new Promise((resolve) => setTimeout(resolve, 200));
    f.cleanup();
  }
});

// Discovery

test('projects lists only Muse-enabled projects and status is ready', async () => {
  const r = await muse('GET', '/muse/v1/projects');
  assert.deepEqual(r.json, { ok: true, projects: [{ code: 'alpha', name: 'Alpha' }] });
  const s = await muse('GET', '/muse/v1/status');
  assert.equal(s.json.ok, true);
  assert.equal(s.json.status, 'ready');
});

test('resolveProject takes a code or name case-insensitively and only for Muse projects', () => {
  assert.equal(resolveProject('alpha'), 'alpha');
  assert.equal(resolveProject(' ALPHA '), 'alpha');
  assert.equal(resolveProject('Alpha'), 'alpha');
  for (const bad of ['bravo', 'Bravo', 'ghost', '', '  ', null, undefined, 7]) assert.equal(resolveProject(bad), null, String(bad));
});

// Ask validation

test('ask rejects unavailable projects without echoing the name', async () => {
  for (const project of ['bravo', 'ghost-project', 'Bravo']) {
    const r = await ask(uid('c'), uid('r'), 'hello', project);
    assert.equal(r.status, 400, project);
    assert.ok(!r.text.toLowerCase().includes(project.toLowerCase()), `echoed ${project}`);
  }
});

test('ask without project uses the only Muse project', async () => {
  const done = await askDone('no project given', undefined);
  assert.equal(done.project, 'Alpha');
  assert.equal(done.project_code, 'alpha');
});

test('ask rejects missing fields, bad ids, unexpected fields and empty text', async () => {
  const post = (body) => muse('POST', '/muse/v1/chats/ask', { body });
  assert.equal((await post({ request_id: 'r', project: 'alpha', text: 'x' })).status, 400);
  assert.equal((await post({ chat_id: 'c', project: 'alpha', text: 'x' })).status, 400);
  assert.equal((await post({ chat_id: 'c', request_id: 'bad id!', project: 'alpha', text: 'x' })).status, 400);
  assert.equal((await post({ chat_id: 'c', request_id: 'r', project: 'alpha', text: 'x', extra: 1 })).status, 400);
  assert.equal((await post({ chat_id: 'c', request_id: 'r', project: 'alpha', text: 5 })).status, 400);
  for (const text of ['', '   ']) assert.equal((await post({ chat_id: 'c', request_id: 'r', project: 'alpha', text })).status, 400);
  assert.equal((await muse('POST', '/muse/v1/chats/ask', { headers: { 'Content-Type': 'application/json' }, body: '{nope' })).status, 400);
  assert.equal((await muse('POST', '/muse/v1/chats/ask', { headers: { 'Content-Type': 'application/json' }, body: '[]' })).status, 400);
});

test('ask rejects text over 8000 characters, also after NFKC folding', async () => {
  assert.equal((await ask(uid('c'), uid('r'), 'x'.repeat(8001))).status, 413);
  // U+FDFA folds to 18 characters, so 500 of them pass the raw cap but not the folded one.
  assert.equal((await ask(uid('c'), uid('r'), String.fromCodePoint(0xFDFA).repeat(500))).status, 413);
});

test('ask rejects bodies over the configured limit', async () => {
  const r = await muse('POST', '/muse/v1/chats/ask', {
    headers: { 'Content-Type': 'application/json' },
    body: `{"text":"${'x'.repeat(state.fixture.config.connector.maxBodyBytes + 100)}"}`,
  });
  assert.equal(r.status, 413);
});

// Idempotency, conflict, read

test('ask is 202 first, 200 on an exact retry, 409 when the text changes', async () => {
  const chat = uid('c');
  const first = await ask(chat, 'r1', 'hello muse');
  assert.equal(first.status, 202);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.chat_id, chat);
  assert.equal(first.json.project_code, 'alpha');
  assert.equal(first.json.reused, false);
  const done = await waitDone(chat, 'r1');
  assert.equal(done.status, 'idle');
  assert.equal(done.error, null);
  assert.ok(done.reply.includes('You asked: "hello muse"'), done.reply);

  const retry = await ask(chat, 'r1', 'hello muse');
  assert.equal(retry.status, 200);
  assert.equal(retry.json.reused, true);
  assert.equal(retry.json.status, 'idle');
  assert.equal(retry.json.reply, done.reply, 'a retry returns the stored reply, not a new turn');

  const changed = await ask(chat, 'r1', 'something else');
  assert.equal(changed.status, 409);

  const next = await ask(chat, 'r2', 'second');
  assert.equal(next.status, 202, 'the same chat continues with a new request_id');
  assert.ok((await waitDone(chat, 'r2')).reply.includes('You asked: "second"'));
});

test('read: unknown request is 404, missing ids are 400, extra params are 400', async () => {
  assert.equal((await read('no-such-chat', 'r1')).status, 404);
  assert.equal((await muse('GET', '/muse/v1/chats/read')).status, 400);
  assert.equal((await muse('GET', '/muse/v1/chats/read?chat_id=a&request_id=b&project=alpha')).status, 400);
});

test('a reply naming a withheld pattern has those lines redacted', async () => {
  const done = await askDone('please reveal the secret handshake');
  assert.ok(done.reply.includes('[line withheld]'), done.reply);
  assert.ok(!done.reply.includes('secret handshake'));
});

test('muse turns reach the engine labeled, NFKC folded and without @ mentions', async () => {
  assert.equal(museTurnText('/cost @a \uFF20b \uFE6Bc x@y'), 'Muse request: /cost (at)a (at)b (at)c x(at)y');
  const done = await askDone('quote @../config.json and \uFF20C:/x');
  assert.ok(done.reply.includes('You asked: "quote (at)../config.json and (at)C:/x"'), done.reply);
});

// Tool policy of a Muse session

test('muse tool policy: allowlisted read ok, everything else denied, inbox is create-only', async () => {
  assert.ok((await tool('read_file', { path: 'README.md' })).includes('Alpha readme'));
  for (const denied of [
    await tool('run_command', { command: 'echo hi' }),
    await tool('read_file', { path: '../bravo/project-notes.md' }),
    await tool('edit_file', { path: 'project-notes.md', old_string: 'a', new_string: 'b' }),
    await tool('write_file', { path: 'README.md', content: 'x\n' }),
  ]) assert.ok(denied.includes('denied'), denied);
  // The denial text itself names the withheld file, so the reply guard redacts it; the content must not leak.
  const withheld = await tool('read_file', { path: 'secret-plan.md' });
  assert.ok(/denied|line withheld/.test(withheld) && !withheld.includes('# secret plan'), withheld);
  assert.ok(fs.readFileSync(path.join(state.fixture.alpha, 'README.md'), 'utf8').startsWith('# Alpha readme'));

  const name = `tool-${process.pid}.md`;
  const created = await tool('write_file', { path: `Muse-Inbox/${name}`, content: 'first\n' });
  assert.ok(created.includes('created Muse-Inbox/'), created);
  assert.equal(fs.readFileSync(path.join(state.fixture.alpha, 'Muse-Inbox', name), 'utf8'), 'first\n');
  const second = await tool('write_file', { path: `Muse-Inbox/${name}`, content: 'second\n' });
  assert.ok(second.includes('denied'), second);
  assert.equal(fs.readFileSync(path.join(state.fixture.alpha, 'Muse-Inbox', name), 'utf8'), 'first\n');
});

test('muse turn stops after the step cap', async () => {
  const done = await askDone('spam 8');
  assert.ok(done.reply.includes('last call: error: step limit reached'), done.reply);
});

// Files route

test('POST /files creates a new note, is idempotent, and never overwrites', async () => {
  const name = `file-${process.pid}.md`;
  const body = { project: 'alpha', request_id: uid('f'), filename: name, content: 'a note\n' };
  const first = await muse('POST', '/muse/v1/files', { body });
  assert.equal(first.status, 200, first.text);
  assert.equal(fs.readFileSync(path.join(state.fixture.alpha, 'Muse-Inbox', name), 'utf8'), 'a note\n');
  const retry = await muse('POST', '/muse/v1/files', { body });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.json, first.json);
  assert.equal((await muse('POST', '/muse/v1/files', { body: { ...body, content: 'other\n' } })).status, 409);
  assert.equal((await muse('POST', '/muse/v1/files', { body: { ...body, request_id: uid('f') } })).status, 409, 'existing filename');
  assert.equal(fs.readFileSync(path.join(state.fixture.alpha, 'Muse-Inbox', name), 'utf8'), 'a note\n');
});

test('POST /files rejects bad input', async () => {
  const good = { project: 'alpha', request_id: uid('f'), filename: 'x.md', content: 'x\n' };
  assert.equal((await muse('POST', '/muse/v1/files', { body: { ...good, extra: 1 } })).status, 400);
  assert.equal((await muse('POST', '/muse/v1/files', { body: { ...good, request_id: 'bad id' } })).status, 400);
  assert.equal((await muse('POST', '/muse/v1/files', { body: { ...good, filename: '../x.md' } })).status, 400);
  assert.equal((await muse('POST', '/muse/v1/files', { body: { ...good, project: 'bravo' } })).status, 400);
  assert.equal((await muse('POST', '/muse/v1/files', { body: { ...good, content: 'l\n'.repeat(41) } })).status, 400);
  assert.equal((await muse('POST', '/muse/v1/files', { body: { ...good, content: 'x'.repeat(17000) } })).status, 413);
});

// Busy, timeout and restart fencing

test('a stuck turn blocks other chats with 409, then times out to error and the next chat works', async () => {
  const chat = uid('c');
  assert.equal((await ask(chat, 'r1', 'hang')).status, 202);
  assert.equal((await ask(uid('c'), uid('r'), 'second while stuck')).status, 409);
  assert.equal((await muse('GET', '/muse/v1/status')).json.status, 'busy');
  assert.equal((await ask(chat, 'r1', 'hang')).status, 200, 'an exact retry is still answered while busy');

  const done = await waitDone(chat, 'r1'); // 3 s wall clock
  assert.equal(done.status, 'error');
  assert.match(done.error, /Interrupted outcome/);
  assert.equal(done.reply, null);
  assert.equal((await ask(chat, 'r2', 'after the timeout')).status, 409, 'an uncertain request blocks its chat');

  const other = await askDone('after the timeout, other chat');
  assert.equal(other.status, 'idle');
  assert.equal((await muse('GET', '/muse/v1/status')).json.status, 'ready');
});

test('restart fences an unfinished request to uncertain and never replays it', async () => {
  const f = makeFixture();
  const port = randomPort();
  const start = () => boot(f, { connectorPort: port, turnMs: '60000', waitFor: ON });
  let server = await start();
  try {
    assert.equal((await muse('POST', '/muse/v1/chats/ask', { port, body: { chat_id: 'cx', request_id: 'r1', project: 'alpha', text: 'hang' } })).status, 202);
    await stop(server);
    server = await start();
    const after = await muse('GET', '/muse/v1/chats/read?chat_id=cx&request_id=r1', { port });
    assert.equal(after.status, 200);
    assert.equal(after.json.status, 'error');
    assert.match(after.json.error, /Interrupted outcome/);
    const retry = await muse('POST', '/muse/v1/chats/ask', { port, body: { chat_id: 'cx', request_id: 'r1', project: 'alpha', text: 'hang' } });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.reused, true);
    assert.equal((await muse('POST', '/muse/v1/chats/ask', { port, body: { chat_id: 'cx', request_id: 'r2', project: 'alpha', text: 'next' } })).status, 409);
    assert.equal((await muse('GET', '/muse/v1/status', { port })).json.status, 'ready');
  } finally {
    await stop(server);
    await new Promise((resolve) => setTimeout(resolve, 200));
    f.cleanup();
  }
});
