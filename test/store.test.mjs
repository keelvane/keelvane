import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-store-test-'));
  return { store: openStore(dir), dir };
}

test('createSession / getSession / listSessions', () => {
  const { store, dir } = freshStore();
  try {
    const a = store.createSession({ project: 'alpha', engine: 'claude', model: 'haiku', title: 'A' });
    const b = store.createSession({ project: 'bravo', engine: 'claude', model: 'sonnet', title: 'B' });
    assert.equal(store.getSession(a.id).title, 'A');
    const all = store.listSessions();
    assert.equal(all.length, 2);
    assert.ok(all.find((s) => s.id === a.id));
    assert.ok(all.find((s) => s.id === b.id));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateSession only touches whitelisted columns', () => {
  const { store, dir } = freshStore();
  try {
    const s = store.createSession({ project: 'alpha', engine: 'claude', model: 'haiku', title: 'A' });
    const updated = store.updateSession(s.id, { status: 'running', engine_session_id: 'es-1', project: 'bravo' });
    assert.equal(updated.status, 'running');
    assert.equal(updated.engine_session_id, 'es-1');
    assert.equal(updated.project, 'alpha'); // not in the whitelist, must be unchanged
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendEvent assigns per-session monotonic seq', () => {
  const { store, dir } = freshStore();
  try {
    const a = store.createSession({ project: 'alpha', engine: 'claude', model: 'haiku', title: 'A' });
    const b = store.createSession({ project: 'alpha', engine: 'claude', model: 'haiku', title: 'B' });
    store.appendEvent(a.id, 'text_delta', { text: '1' });
    store.appendEvent(b.id, 'text_delta', { text: 'x' });
    const e2 = store.appendEvent(a.id, 'text_delta', { text: '2' });
    assert.equal(e2.seq, 2);
    const aEvents = store.listEvents(a.id);
    assert.deepEqual(aEvents.map((e) => e.seq), [1, 2]);
    const bEvents = store.listEvents(b.id);
    assert.deepEqual(bEvents.map((e) => e.seq), [1]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listEvents supports replay via afterSeq', () => {
  const { store, dir } = freshStore();
  try {
    const s = store.createSession({ project: 'alpha', engine: 'claude', model: 'haiku', title: 'A' });
    store.appendEvent(s.id, 'text_delta', { text: '1' });
    store.appendEvent(s.id, 'text_delta', { text: '2' });
    store.appendEvent(s.id, 'text_delta', { text: '3' });
    const after = store.listEvents(s.id, 1);
    assert.deepEqual(after.map((e) => e.payload.text), ['2', '3']);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('approvals: create then update sets status and decided_at', () => {
  const { store, dir } = freshStore();
  try {
    const s = store.createSession({ project: 'alpha', engine: 'claude', model: 'haiku', title: 'A' });
    const approval = store.createApproval({ sessionId: s.id, tool: 'run_command', summary: 'ls' });
    assert.equal(approval.status, 'pending');
    assert.equal(approval.decided_at, null);
    const decided = store.updateApproval(approval.id, { status: 'approved' });
    assert.equal(decided.status, 'approved');
    assert.ok(decided.decided_at);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resetStale idles running sessions and expires pending approvals', () => {
  const { store, dir } = freshStore();
  try {
    const s = store.createSession({ project: 'alpha', engine: 'claude', model: 'haiku' });
    store.updateSession(s.id, { status: 'running' });
    const a = store.createApproval({ sessionId: s.id, tool: 'run_command', summary: 'dir' });
    store.resetStale();
    assert.equal(store.getSession(s.id).status, 'idle');
    assert.equal(store.getApproval(a.id).status, 'expired');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
