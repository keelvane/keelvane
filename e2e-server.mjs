// Standalone end-to-end exercise for server.mjs with KEELVANE_FAKE_ENGINE=1.
// Lives outside test/ and does not use node:test; run directly by npm test,
// in addition to (not instead of) `node --test`. No node:test dependency is
// needed here - kept standalone for a simple, readable top-to-bottom script.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './test/fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, 'server.mjs');

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

async function bootServer() {
  const port = 20000 + Math.floor(Math.random() * 5000);
  const fixture = makeFixture();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      ...fixture.env,
      KEELVANE_PORT: String(port),
      KEELVANE_FAKE_ENGINE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
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
    fixture,
    async stop() {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
      fixture.cleanup();
    },
  };
}

// Returns { ready, done }. `ready` resolves once the server's synchronous
// ': connected\n\n' preamble has been observed on the wire - handleEvents in
// server.mjs writes that preamble and registers the subscriber in the same
// synchronous pass, so seeing it proves the subscription is already in place
// and no event emitted after this point can be missed. `done` resolves with
// the collected events once a 'turn_finished' event has been seen.
function openSse(url, timeoutMs = 15000) {
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
  return { ready, done };
}

// GET /events?after=N never closes its response - handleEvents in server.mjs
// writes the replayed events, then registers the connection as a live
// subscriber forever, exactly like a fresh subscription. So it can't be read
// with request() (which waits for res.on('end')); this closes the connection
// itself once it has seen the expected number of "data: " lines, the same
// destroy-once-satisfied approach openSse uses above.
function readReplay(url, expectedCount, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let buf = '';
    let settled = false;
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      const finish = () => {
        settled = true;
        req.destroy();
        resolve({ status: res.statusCode, count: (buf.match(/^data: /gm) || []).length });
      };
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (!settled && (buf.match(/^data: /gm) || []).length >= expectedCount) finish();
      });
      res.on('end', () => { if (!settled) finish(); });
    });
    req.on('error', (err) => {
      if (!settled && !err.message.includes('socket hang up')) { settled = true; reject(err); }
    });
    req.setTimeout(timeoutMs, () => {
      if (!settled) { settled = true; req.destroy(); reject(new Error(`replay read timed out on ${u.pathname}`)); }
    });
  });
}

async function main() {
  const started = Date.now();
  const srv = await bootServer();
  try {
    // Create a session.
    const createRes = await request(`${srv.base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Keelvane-Action': 'confirmed' },
      body: JSON.stringify({ project: 'alpha', engine: 'claude', model: 'haiku' }),
    });
    assert.equal(createRes.status, 200);
    const { session } = JSON.parse(createRes.body);
    assert.ok(session.id);
    assert.equal(session.project, 'alpha');

    // Unknown project is rejected.
    const badProjectRes = await request(`${srv.base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Keelvane-Action': 'confirmed' },
      body: JSON.stringify({ project: 'nope', engine: 'claude', model: 'haiku' }),
    });
    assert.equal(badProjectRes.status, 400);

    // Open SSE and wait for the preamble before sending the message.
    const sse = openSse(`${srv.base}/api/sessions/${session.id}/events`);
    await sse.ready;

    // Send the message.
    const sendRes = await request(`${srv.base}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Keelvane-Action': 'confirmed' },
      body: JSON.stringify({ text: 'What is the first heading in project-notes.md?' }),
    });
    assert.equal(sendRes.status, 202);

    // Collect events until turn_finished.
    const events = await sse.done;
    const types = events.map((e) => e.type);
    assert.ok(types.includes('user_message'), types.join(','));
    assert.ok(types.includes('tool_started'), types.join(','));
    assert.ok(types.includes('tool_finished'), types.join(','));
    assert.ok(types.includes('text_delta'), types.join(','));
    assert.ok(types.includes('turn_finished'), types.join(','));

    const toolFinished = events.find((e) => e.type === 'tool_finished');
    assert.ok(toolFinished);
    assert.equal(toolFinished.payload.ok, true);
    assert.match(toolFinished.payload.result, /# Alpha project notes/);

    // Replay from after the first event's seq must skip everything up to and
    // including that seq.
    const firstSeq = events[0].seq;
    const expectedReplayCount = events.length - 1;
    const replay = await readReplay(
      `${srv.base}/api/sessions/${session.id}/events?after=${firstSeq}`,
      expectedReplayCount
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.count, expectedReplayCount);

    // Session shows up in the list.
    const listRes = await request(`${srv.base}/api/sessions`);
    assert.equal(listRes.status, 200);
    const list = JSON.parse(listRes.body);
    assert.ok(list.sessions.some((s) => s.id === session.id));

    const elapsed = Date.now() - started;
    console.log(`ok - fake-engine session end to end (${events.length} events, ${elapsed}ms)`);
  } finally {
    await srv.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
