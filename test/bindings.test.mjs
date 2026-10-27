import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { createBindings, BindingError } from '../connector/bindings.mjs';
import { createMuseFiles } from '../connector/files.mjs';
import { resolveProject } from '../remote.mjs';
import { useFixture } from './fixture.mjs';

let fixture;
const dirs = [];
const stores = [];

before(() => { fixture = useFixture(); });
after(() => { for (const s of stores) { try { s.close(); } catch { /* closed */ } } fixture.cleanup(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-bind-test-'));
  dirs.push(dir);
  const store = openStore(dir);
  stores.push(store);
  const make = () => createBindings({
    db: store.db,
    projects: fixture.config.projects,
    createSession: (code) => store.createSession({ project: code, engine: 'claude', model: 'sonnet', title: 'Muse', profile: 'muse' }).id,
  });
  return { store, dir, bindings: make(), make };
}

function rejects(fn, status, pattern) {
  assert.throws(fn, (error) => error instanceof BindingError && error.status === status && (!pattern || pattern.test(error.message)));
}

test('accept, read, complete', () => {
  const { bindings } = fresh();
  const a = bindings.accept({ chatId: 'c1', requestId: 'r1', text: 'hello', projectCode: 'alpha' });
  assert.equal(a.state, 'accepted');
  assert.equal(a.reused, false);
  assert.equal(a.projectCode, 'alpha');
  assert.equal(bindings.boundSession('c1'), a.sessionId);
  assert.equal(bindings.read({ chatId: 'c1', requestId: 'r1' }).state, 'accepted');
  assert.equal(bindings.complete(a.sessionId, 'the reply'), true);
  const done = bindings.read({ chatId: 'c1', requestId: 'r1' });
  assert.equal(done.state, 'completed');
  assert.equal(done.result, 'the reply');
  assert.equal(bindings.complete(a.sessionId, 'again'), false, 'nothing is waiting any more');
});

test('exact retry is reused; changed text is a 409 conflict; CRLF and NFC fold to the same payload', () => {
  const { bindings } = fresh();
  const first = bindings.accept({ chatId: 'c1', requestId: 'r1', text: 'line1\nline2 é', projectCode: 'alpha' });
  const retry = bindings.accept({ chatId: 'c1', requestId: 'r1', text: 'line1\r\nline2 é', projectCode: 'alpha' });
  assert.equal(retry.reused, true);
  assert.equal(retry.sessionId, first.sessionId);
  rejects(() => bindings.accept({ chatId: 'c1', requestId: 'r1', text: 'different', projectCode: 'alpha' }), 409, /conflicts/);
});

test('a chat binds to one project; another project is 409', () => {
  const { bindings } = fresh();
  bindings.accept({ chatId: 'c1', requestId: 'r1', text: 'hi', projectCode: 'alpha' });
  rejects(() => bindings.accept({ chatId: 'c1', requestId: 'r2', text: 'hi', projectCode: 'bravo' }), 409, /another project/);
});

test('a second request while one is unfinished is 409; after completion it is accepted', () => {
  const { bindings } = fresh();
  const a = bindings.accept({ chatId: 'c1', requestId: 'r1', text: 'one', projectCode: 'alpha' });
  rejects(() => bindings.accept({ chatId: 'c1', requestId: 'r2', text: 'two', projectCode: 'alpha' }), 409, /unfinished/);
  bindings.complete(a.sessionId, 'ok');
  const b = bindings.accept({ chatId: 'c1', requestId: 'r2', text: 'two', projectCode: 'alpha' });
  assert.equal(b.reused, false);
  assert.equal(b.sessionId, a.sessionId, 'one session per chat');
});

test('fail records the message; uncertain clears the reply and blocks the next request', () => {
  const { bindings } = fresh();
  const a = bindings.accept({ chatId: 'c1', requestId: 'r1', text: 'one', projectCode: 'alpha' });
  assert.equal(bindings.fail(a.sessionId, 'boom'), true);
  const failed = bindings.read({ chatId: 'c1', requestId: 'r1' });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.result, 'boom');
  const b = bindings.accept({ chatId: 'c2', requestId: 'r1', text: 'one', projectCode: 'alpha' });
  assert.equal(bindings.uncertain(b.sessionId), true);
  const u = bindings.read({ chatId: 'c2', requestId: 'r1' });
  assert.equal(u.state, 'uncertain');
  assert.equal(u.result, null);
  rejects(() => bindings.accept({ chatId: 'c2', requestId: 'r2', text: 'next', projectCode: 'alpha' }), 409, /unfinished/);
});

test('read of an unknown request is 404; invalid ids and text are 400', () => {
  const { bindings } = fresh();
  rejects(() => bindings.read({ chatId: 'nope', requestId: 'r1' }), 404);
  rejects(() => bindings.accept({ chatId: '', requestId: 'r1', text: 'x', projectCode: 'alpha' }), 400);
  rejects(() => bindings.accept({ chatId: 'c\u0001', requestId: 'r1', text: 'x', projectCode: 'alpha' }), 400);
  rejects(() => bindings.accept({ chatId: 'c', requestId: 'r'.repeat(129), text: 'x', projectCode: 'alpha' }), 400);
  rejects(() => bindings.accept({ chatId: 'c', requestId: 'r1', text: '   ', projectCode: 'alpha' }), 400);
});

test('foreign key: an unknown project is refused and creates no session', () => {
  const { bindings, store } = fresh();
  rejects(() => bindings.accept({ chatId: 'c1', requestId: 'r1', text: 'x', projectCode: 'ghost' }), 400, /Unknown project/);
  assert.equal(store.listSessions().length, 0);
  assert.equal(bindings.boundSession('c1'), null);
});

test('a failed accept rolls back and leaves the handle usable', () => {
  const { store } = fresh();
  const bindings = createBindings({
    db: store.db,
    projects: fixture.config.projects,
    createSession: () => { throw new Error('no session'); },
  });
  assert.throws(() => bindings.accept({ chatId: 'c1', requestId: 'r1', text: 'x', projectCode: 'alpha' }), /no session/);
  assert.equal(bindings.boundSession('c1'), null);
  assert.throws(() => bindings.accept({ chatId: 'c1', requestId: 'r1', text: 'x', projectCode: 'alpha' }), /no session/);
});

test('restart fence: accepted becomes uncertain and is never replayed', () => {
  const { bindings, make } = fresh();
  const a = bindings.accept({ chatId: 'c1', requestId: 'r1', text: 'one', projectCode: 'alpha' });
  const restarted = make();
  assert.equal(restarted.read({ chatId: 'c1', requestId: 'r1' }).state, 'uncertain');
  const retry = restarted.accept({ chatId: 'c1', requestId: 'r1', text: 'one', projectCode: 'alpha' });
  assert.equal(retry.reused, true, 'an exact retry returns the fenced record, not a new turn');
  assert.equal(retry.state, 'uncertain');
  assert.equal(retry.sessionId, a.sessionId);
  assert.equal(restarted.complete(a.sessionId, 'late'), false, 'a late completion cannot overwrite a fenced request');
});

test('project names sync from config on start', () => {
  const { store } = fresh();
  assert.deepEqual(store.db.prepare('SELECT code, name FROM projects ORDER BY code').all().map((r) => ({ ...r })),
    [{ code: 'alpha', name: 'Alpha' }, { code: 'bravo', name: 'Bravo' }]);
});

// connector/files.mjs

function filesHarness() {
  const { store } = fresh();
  return { store, files: createMuseFiles({ db: store.db, resolveProject }) };
}
const inbox = () => path.join(fixture.alpha, 'Muse-Inbox');

test('files: saves a new note in the inbox and replays an exact retry without rewriting', () => {
  const { files } = filesHarness();
  const data = { project: 'alpha', request_id: 'f1', filename: 'note-one.md', content: 'hello\n' };
  const first = files.save(data);
  assert.equal(first.code, 200, JSON.stringify(first.body));
  assert.equal(first.body.status, 'completed');
  assert.equal(first.body.result.path, 'Muse-Inbox/note-one.md');
  assert.equal(fs.readFileSync(path.join(inbox(), 'note-one.md'), 'utf8'), 'hello\n');
  fs.writeFileSync(path.join(inbox(), 'note-one.md'), 'edited later\n');
  const retry = files.save(data);
  assert.equal(retry.code, 200);
  assert.deepEqual(retry.body, first.body);
  assert.equal(fs.readFileSync(path.join(inbox(), 'note-one.md'), 'utf8'), 'edited later\n');
});

test('files: request_id reuse with other content is 409; existing filename is 409 and nothing is replaced', () => {
  const { files } = filesHarness();
  assert.equal(files.save({ project: 'alpha', request_id: 'f2', filename: 'two.md', content: 'a\n' }).code, 200);
  const conflict = files.save({ project: 'alpha', request_id: 'f2', filename: 'two.md', content: 'b\n' });
  assert.equal(conflict.code, 409);
  assert.equal(conflict.body.error.code, 'request_conflict');
  const exists = files.save({ project: 'alpha', request_id: 'f3', filename: 'two.md', content: 'c\n' });
  assert.equal(exists.code, 409);
  assert.equal(exists.body.error.code, 'file_exists');
  assert.equal(fs.readFileSync(path.join(inbox(), 'two.md'), 'utf8'), 'a\n');
});

test('files: non-Muse or unknown project, bad filename and oversized content are 400', () => {
  const { files } = filesHarness();
  for (const project of ['bravo', 'ghost', undefined, 7]) {
    assert.equal(files.save({ project, request_id: 'f4', filename: 'x.md', content: 'x' }).code, 400, String(project));
  }
  for (const filename of ['../x.md', 'a/b.md', 'x.exe', 'con.md', '', `${'x'.repeat(90)}.md`]) {
    const r = files.save({ project: 'alpha', request_id: 'f5', filename, content: 'x' });
    assert.equal(r.code, 400, filename);
    assert.equal(r.body.error.code, 'invalid_file');
  }
  const long = files.save({ project: 'alpha', request_id: 'f6', filename: 'long.md', content: 'x\n'.repeat(41) });
  assert.equal(long.code, 400);
  assert.equal(fs.existsSync(path.join(inbox(), 'long.md')), false);
});

test('files: project may be addressed by name, case-insensitively', () => {
  const { files } = filesHarness();
  assert.equal(files.save({ project: 'ALPHA', request_id: 'f7', filename: 'byname.txt', content: 'x' }).code, 200);
});

test('files: restart fences a running save to uncertain', () => {
  const { store } = filesHarness();
  store.db.prepare("INSERT INTO muse_files (request_id, payload_sha256, state, created_at) VALUES ('f8', 'h', 'running', 'now')").run();
  createMuseFiles({ db: store.db, resolveProject });
  const row = store.db.prepare("SELECT state, http_code FROM muse_files WHERE request_id = 'f8'").get();
  assert.equal(row.state, 'uncertain');
  assert.equal(row.http_code, 503);
});
