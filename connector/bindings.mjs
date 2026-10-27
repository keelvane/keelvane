// Chat-binding journal for the Muse connector. A Muse chat binds once to one project and one Keelvane
// session. A request is identified by (chat, request_id): an exact retry reuses the turn, a changed
// payload is a conflict, and a restart fences unfinished work to "uncertain" so it is never replayed.
// Project codes come from config through the projects table (foreign key), not from a hardcoded list.
import { createHash, randomUUID } from 'node:crypto';

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export class BindingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function createBindings({ db, projects, createSession, now = () => new Date().toISOString(), uuid = randomUUID }) {
  const sync = db.prepare('INSERT INTO projects (code, name) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name');
  for (const p of projects) sync.run(p.code, p.name);
  // Factory initialization is the restart boundary.
  db.prepare("UPDATE muse_requests SET state = 'uncertain', updated_at = ? WHERE state = 'accepted'").run(now());

  const fail = (message, status) => { throw new BindingError(message, status); };
  function bounded(value, name, max) {
    if (typeof value !== 'string' || !value.length || value.length > max || CONTROL.test(value)) fail(`Invalid ${name}`);
    return value;
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }
  const dto = (row, reused) => ({
    requestId: row.request_id, state: row.state, result: row.result_text, createdAt: row.created_at,
    projectCode: row.project_code, sessionId: row.session_id, ...(reused === undefined ? {} : { reused }),
  });
  const SELECT = `SELECT r.request_id, r.payload_sha256, r.state, r.result_text, r.created_at, b.project_code, b.session_id, b.id AS binding_id
    FROM muse_requests r JOIN muse_bindings b ON b.id = r.binding_id`;

  function accept({ chatId, requestId, text, projectCode }) {
    bounded(chatId, 'chat_id', 512);
    bounded(requestId, 'request_id', 128);
    if (typeof text !== 'string' || !text.trim()) fail('Invalid text');
    const canonical = text.replace(/\r\n?/g, '\n').normalize('NFC');
    const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
    return transaction(() => {
      let binding = db.prepare('SELECT * FROM muse_bindings WHERE chat_id = ?').get(chatId);
      if (!binding) {
        if (!db.prepare('SELECT 1 AS ok FROM projects WHERE code = ?').get(projectCode)) fail('Unknown project');
        const sessionId = createSession(projectCode);
        binding = { id: uuid(), chat_id: chatId, project_code: projectCode, session_id: sessionId, created_at: now() };
        db.prepare('INSERT INTO muse_bindings (id, chat_id, project_code, session_id, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(binding.id, chatId, projectCode, sessionId, binding.created_at);
      } else if (projectCode !== binding.project_code) {
        fail('Chat is already bound to another project', 409);
      }
      const previous = db.prepare(`${SELECT} WHERE r.binding_id = ? AND r.request_id = ?`).get(binding.id, requestId);
      if (previous) {
        if (previous.payload_sha256 !== hash) fail('request_id conflicts with a different payload', 409);
        return dto(previous, true);
      }
      if (db.prepare("SELECT 1 AS pending FROM muse_requests WHERE binding_id = ? AND state IN ('accepted','uncertain') LIMIT 1").get(binding.id)) {
        fail('This chat has an unfinished request; read it first', 409);
      }
      const at = now();
      db.prepare("INSERT INTO muse_requests (id, binding_id, request_id, payload_sha256, state, result_text, created_at, updated_at) VALUES (?, ?, ?, ?, 'accepted', NULL, ?, ?)")
        .run(uuid(), binding.id, requestId, hash, at, at);
      return { requestId, state: 'accepted', result: null, createdAt: at, projectCode: binding.project_code, sessionId: binding.session_id, reused: false };
    });
  }

  function read({ chatId, requestId }) {
    bounded(chatId, 'chat_id', 512);
    bounded(requestId, 'request_id', 128);
    const row = db.prepare(`${SELECT} WHERE b.chat_id = ? AND r.request_id = ?`).get(chatId, requestId);
    if (!row) fail('Request unavailable', 404);
    return dto(row);
  }

  // Settles the one accepted request of a session. Returns false when nothing was waiting.
  function settle(sessionId, state, resultText) {
    const row = db.prepare(`${SELECT} WHERE b.session_id = ? AND r.state = 'accepted'`).get(sessionId);
    if (!row) return false;
    db.prepare("UPDATE muse_requests SET state = ?, result_text = ?, updated_at = ? WHERE binding_id = ? AND request_id = ? AND state = 'accepted'")
      .run(state, resultText, now(), row.binding_id, row.request_id);
    return true;
  }

  return {
    accept,
    read,
    complete: (sessionId, reply) => settle(sessionId, 'completed', reply),
    fail: (sessionId, message) => settle(sessionId, 'failed', message),
    uncertain: (sessionId) => settle(sessionId, 'uncertain', null),
    boundSession: (chatId) => db.prepare('SELECT session_id FROM muse_bindings WHERE chat_id = ?').get(chatId)?.session_id ?? null,
  };
}
