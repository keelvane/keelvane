// Boots server.mjs as a real child process with KEELVANE_FAKE_ENGINE=1 so
// a whole session runs without ever touching the real claude CLI or costing a
// model call, then exercises browser-safety auth gates and M2 write/approval
// flows.
//
// The end-to-end SSE coverage lives in a separate standalone script,
// e2e-server.mjs at the package root, run directly by npm test as a second
// step. It is a plain script (no node:test) for readability, not because of
// any node:test limitation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'server.mjs');

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

async function bootServer({ fixture, port } = {}) {
  const chosenPort = port || 20000 + Math.floor(Math.random() * 5000);
  const ownsFixture = !fixture; // a caller-supplied fixture outlives this server (resume test)
  const fx = fixture || makeFixture();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      ...fx.env,
      KEELVANE_PORT: String(chosenPort),
      KEELVANE_FAKE_ENGINE: '1',
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
    child.on('exit', (code) => reject(new Error(`server exited early with code ${code}`)));
  });
  return {
    base,
    fixture: fx,
    async stop() {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
      if (ownsFixture) fx.cleanup();
    },
  };
}

// Returns { ready, done }. `ready` resolves once the server's synchronous
// ': connected\n\n' preamble has been observed on the wire - handleEvents in
// server.mjs writes that preamble and registers the subscriber in the same
// synchronous pass, so seeing it proves the subscription is already in place
// and no event emitted after this point can be missed. `done` resolves with
// the collected events once a 'turn_finished' event has been seen.
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

async function sendMessage(base, sessionId, text) {
  const res = await request(`${base}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Keelvane-Action': 'confirmed' },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 202);
}

test('server: follow-ups reject overlap, pending approval and archived sessions', async () => {
  const srv=await bootServer();
  const post=(id,text)=>request(`${srv.base}/api/sessions/${id}/messages`,{method:'POST',headers:{'Content-Type':'application/json','X-Keelvane-Action':'confirmed'},body:JSON.stringify({text})});
  try {
    const session=await createSession(srv.base,'alpha');
    const sse=openSse(`${srv.base}/api/sessions/${session.id}/events`);
    await sse.ready;
    const responses=await Promise.all([post(session.id,'hello'),post(session.id,'other turn')]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[202,409]);
    await sse.done;
    const pending=openSse(`${srv.base}/api/sessions/${session.id}/events?after=${Math.max(...sse.events.map(e=>e.seq))}`);
    await pending.ready;
    assert.equal((await post(session.id,'tool {"tool":"run_command","args":{"command":"Write-Output probe"}}')).status,202);
    const approval=await waitForEvent(pending.events,'approval_requested');
    assert.equal((await post(session.id,'blocked while approval pending')).status,409);
    await postApproval(srv.base,session.id,approval.payload.approval_id,'deny');
    await pending.done;
    await request(`${srv.base}/api/sessions/${session.id}/archive`,{method:'POST',headers:{'X-Keelvane-Action':'confirmed'}});
    assert.equal((await post(session.id,'blocked archived')).status,409);
  } finally { await srv.stop(); }
});

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

test('server: browser-safety auth gates', async () => {
  const srv = await bootServer();
  try {
    // Wrong Host header is denied.
    const badHost = await request(`${srv.base}/api/sessions`, { headers: { Host: 'evil.example:9999' } });
    assert.equal(badHost.status, 400);

    // Disallowed Origin is denied.
    const badOrigin = await request(`${srv.base}/api/sessions`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(badOrigin.status, 403);

    // Mutation without X-Keelvane-Action: confirmed is refused.
    const noConfirm = await request(`${srv.base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'alpha', engine: 'claude', model: 'haiku' }),
    });
    assert.equal(noConfirm.status, 403);

    // /api/tool with a bad run token is refused regardless of confirmation header.
    const badToken = await request(`${srv.base}/api/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Keelvane-Run-Token': 'not-a-real-token' },
      body: JSON.stringify({ session_id: 'nope', tool: 'read_file', args: { path: 'x.md' } }),
    });
    assert.equal(badToken.status, 401);
  } finally {
    await srv.stop();
  }
});

test('server: engine and model must pair up', async () => {
  const srv = await bootServer();
  try {
    const create = (engine, model) => request(`${srv.base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Keelvane-Action': 'confirmed' },
      body: JSON.stringify({ project: 'alpha', engine, model }),
    });
    const ok = await create('codex', 'gpt-6-sol');
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).session.engine, 'codex');
    const ok61 = await create('codex', 'gpt-6.1-sol');
    assert.equal(ok61.status, 200);
    assert.equal(JSON.parse(ok61.body).session.engine, 'codex');
    assert.equal((await create('codex', 'haiku')).status, 400);
    assert.equal((await create('claude', 'gpt-6-sol')).status, 400);
    assert.equal((await create('claude', 'gpt-6.1-sol')).status, 400);
    assert.equal((await create('gemini', 'haiku')).status, 400);
  } finally {
    await srv.stop();
  }
});

test('server: run_command approval approve flow', async () => {
  const srv = await bootServer();
  try {
    const session = await createSession(srv.base);
    const sse = openSse(`${srv.base}/api/sessions/${session.id}/events`);
    await sse.ready;

    await sendMessage(srv.base, session.id, 'tool {"tool":"run_command","args":{"command":"Write-Output hi"}}');

    const approval = await waitForEvent(sse.events, 'approval_requested');
    assert.equal(approval.payload.tool, 'run_command');
    assert.equal(approval.payload.args.command, 'Write-Output hi');
    assert.ok(approval.payload.approval_id);

    const approveRes = await postApproval(srv.base, session.id, approval.payload.approval_id, 'approve');
    assert.equal(approveRes.status, 200);

    await waitForEvent(sse.events, 'turn_finished');
    const textDeltas = sse.events.filter((e) => e.type === 'text_delta').map((e) => e.payload.text).join('');
    assert.match(textDeltas, /exit 0/);
    assert.match(textDeltas, /hi/);
  } finally {
    await srv.stop();
  }
});

test('server: run_command approval deny flow', async () => {
  const srv = await bootServer();
  try {
    const session = await createSession(srv.base);
    const sse = openSse(`${srv.base}/api/sessions/${session.id}/events`);
    await sse.ready;

    await sendMessage(srv.base, session.id, 'tool {"tool":"run_command","args":{"command":"Write-Output hi"}}');

    const approval = await waitForEvent(sse.events, 'approval_requested');
    const denyRes = await postApproval(srv.base, session.id, approval.payload.approval_id, 'deny');
    assert.equal(denyRes.status, 200);

    await waitForEvent(sse.events, 'turn_finished');
    const textDeltas = sse.events.filter((e) => e.type === 'text_delta').map((e) => e.payload.text).join('');
    assert.match(textDeltas, /denied by the user/);
  } finally {
    await srv.stop();
  }
});

test('server: approval endpoint auth and unknown id', async () => {
  const srv = await bootServer();
  try {
    const session = await createSession(srv.base);
    const sse = openSse(`${srv.base}/api/sessions/${session.id}/events`);
    await sse.ready;

    await sendMessage(srv.base, session.id, 'tool {"tool":"run_command","args":{"command":"Write-Output hi"}}');

    const approval = await waitForEvent(sse.events, 'approval_requested');

    // Missing X-Keelvane-Action header is refused.
    const noConfirm = await request(`${srv.base}/api/sessions/${session.id}/approvals/${approval.payload.approval_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(noConfirm.status, 403);

    // Unknown approval id is 404.
    const unknown = await postApproval(srv.base, session.id, 'does-not-exist', 'approve');
    assert.equal(unknown.status, 404);

    // Deny the real one so the turn ends.
    const denyRes = await postApproval(srv.base, session.id, approval.payload.approval_id, 'deny');
    assert.equal(denyRes.status, 200);
    await waitForEvent(sse.events, 'turn_finished');
  } finally {
    await srv.stop();
  }
});

test('server: resume after host restart', async () => {
  const fixture = makeFixture();
  const port = 20000 + Math.floor(Math.random() * 5000);
  let srv = await bootServer({ fixture, port });
  let session;
  let lastSeq;
  try {
    session = await createSession(srv.base);
    const sse = openSse(`${srv.base}/api/sessions/${session.id}/events`);
    await sse.ready;
    await sendMessage(srv.base, session.id, 'What is the first heading in project-notes.md?');
    await waitForEvent(sse.events, 'turn_finished');
    lastSeq = Math.max(...sse.events.map((e) => e.seq));
  } finally {
    await srv.stop();
  }

  // Boot a new server on the same data dir and port; skip the replayed first turn.
  srv = await bootServer({ fixture, port });
  try {
    const sse = openSse(`${srv.base}/api/sessions/${session.id}/events?after=${lastSeq}`);
    await sse.ready;
    await sendMessage(srv.base, session.id, 'What is the first heading in project-notes.md?');
    await waitForEvent(sse.events, 'turn_finished');
    const textDeltas = sse.events.filter((e) => e.type === 'text_delta').map((e) => e.payload.text).join('');
    assert.match(textDeltas, /\[resumed fake-/);
  } finally {
    await srv.stop();
    fixture.cleanup();
  }
});

test('server: archive hides a session from the list', async () => {
  const srv = await bootServer();
  try {
    const a = await createSession(srv.base);
    const b = await createSession(srv.base);

    // Missing confirmed header is rejected.
    const noHeader = await request(`${srv.base}/api/sessions/${a.id}/archive`, { method: 'POST' });
    assert.equal(noHeader.status, 403);

    // Wrong method is rejected.
    const wrongMethod = await request(`${srv.base}/api/sessions/${a.id}/archive`, { method: 'GET' });
    assert.equal(wrongMethod.status, 405);

    // Unknown session id is rejected.
    const unknown = await request(`${srv.base}/api/sessions/no-such-session/archive`, {
      method: 'POST',
      headers: { 'X-Keelvane-Action': 'confirmed' },
    });
    assert.equal(unknown.status, 404);

    // Archive session a.
    const archiveA = await request(`${srv.base}/api/sessions/${a.id}/archive`, {
      method: 'POST',
      headers: { 'X-Keelvane-Action': 'confirmed' },
    });
    assert.equal(archiveA.status, 200);
    assert.deepEqual(JSON.parse(archiveA.body), { ok: true });

    // Session list now contains b but not a.
    const listAfterA = await request(`${srv.base}/api/sessions`);
    assert.equal(listAfterA.status, 200);
    const { sessions: sessionsAfterA } = JSON.parse(listAfterA.body);
    assert.ok(sessionsAfterA.some((s) => s.id === b.id));
    assert.ok(!sessionsAfterA.some((s) => s.id === a.id));

    // Run one turn on b so it has a live engine.
    const sse = openSse(`${srv.base}/api/sessions/${b.id}/events`);
    await sse.ready;
    await sendMessage(srv.base, b.id, 'hello');
    await sse.done;

    // Archive b while its engine process is still alive.
    const archiveB = await request(`${srv.base}/api/sessions/${b.id}/archive`, {
      method: 'POST',
      headers: { 'X-Keelvane-Action': 'confirmed' },
    });
    assert.equal(archiveB.status, 200);
    assert.deepEqual(JSON.parse(archiveB.body), { ok: true });

    // Session list is now empty.
    const listAfterB = await request(`${srv.base}/api/sessions`);
    assert.equal(listAfterB.status, 200);
    const { sessions: sessionsAfterB } = JSON.parse(listAfterB.body);
    assert.deepEqual(sessionsAfterB, []);
  } finally {
    await srv.stop();
  }
});
