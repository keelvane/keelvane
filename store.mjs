import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir as configDataDir } from './policy.mjs';

export function openStore(dataDir) {
  const dir = dataDir || configDataDir();
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'keelvane.sqlite'));

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      engine TEXT NOT NULL,
      model TEXT NOT NULL,
      title TEXT,
      engine_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
    CREATE TABLE IF NOT EXISTS projects (code TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS muse_bindings (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL UNIQUE,
      project_code TEXT NOT NULL REFERENCES projects(code),
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS muse_requests (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES muse_bindings(id),
      request_id TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('accepted','uncertain','completed','failed')),
      result_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(binding_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS muse_files (
      request_id TEXT PRIMARY KEY,
      payload_sha256 TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running','uncertain','completed','failed')),
      http_code INTEGER,
      result TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
  `);

  // Archived sessions stay on disk but leave the sidebar.
  if (!db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'archived')) {
    db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  }

  // A session's profile is fixed at creation and can never be changed.
  if (!db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'profile')) {
    db.exec("ALTER TABLE sessions ADD COLUMN profile TEXT NOT NULL DEFAULT 'owner'");
  }

  function getSession(id) {
    const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
    return stmt.get(id);
  }

  function getApproval(id) {
    const stmt = db.prepare('SELECT * FROM approvals WHERE id = ?');
    return stmt.get(id);
  }

  return {
    createSession({ project, engine, model, title, profile = 'owner' }) {
      if (profile !== 'owner' && profile !== 'muse') {
        throw new Error(`unknown profile: ${profile}`);
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const stmt = db.prepare(
        'INSERT INTO sessions (id, project, engine, model, title, engine_session_id, status, profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, \'idle\', ?, ?, ?)'
      );
      stmt.run(id, project, engine, model, title ?? null, profile, now, now);
      return getSession(id);
    },

    getSession,

    listSessions() {
      const stmt = db.prepare('SELECT * FROM sessions WHERE archived = 0 ORDER BY created_at DESC');
      return stmt.all();
    },

    updateSession(id, patch) {
      const allowed = ['title', 'engine_session_id', 'status', 'archived'];
      const keys = Object.keys(patch).filter((key) => allowed.includes(key));
      const now = new Date().toISOString();

      if (keys.length === 0) {
        const stmt = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
        stmt.run(now, id);
      } else {
        const assignments = keys.map((key) => `${key} = ?`).join(', ');
        const values = keys.map((key) => patch[key]);
        const stmt = db.prepare(`UPDATE sessions SET ${assignments}, updated_at = ? WHERE id = ?`);
        stmt.run(...values, now, id);
      }

      return getSession(id);
    },

    appendEvent(sessionId, type, payload) {
      const nextStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?');
      const { next } = nextStmt.get(sessionId);
      const now = new Date().toISOString();
      const insertStmt = db.prepare(
        'INSERT INTO events (session_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)'
      );
      const result = insertStmt.run(sessionId, next, type, JSON.stringify(payload), now);
      return {
        id: result.lastInsertRowid,
        session_id: sessionId,
        seq: next,
        type,
        payload,
        created_at: now,
      };
    },

    listEvents(sessionId, afterSeq = 0) {
      const stmt = db.prepare('SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC');
      const rows = stmt.all(sessionId, afterSeq);
      return rows.map((row) => {
        try {
          return { ...row, payload: JSON.parse(row.payload) };
        } catch {
          return row;
        }
      });
    },

    createApproval({ sessionId, tool, summary }) {
      const id = randomUUID();
      const now = new Date().toISOString();
      const stmt = db.prepare(
        'INSERT INTO approvals (id, session_id, tool, summary, status, created_at, decided_at) VALUES (?, ?, ?, ?, \'pending\', ?, NULL)'
      );
      stmt.run(id, sessionId, tool, summary, now);
      return getApproval(id);
    },

    getApproval,

    updateApproval(id, { status, decidedAt }) {
      const decided = decidedAt || new Date().toISOString();
      const stmt = db.prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?');
      stmt.run(status, decided, id);
      return getApproval(id);
    },

    db,

    // Hard delete: unlike archive, this removes the row and its history for good.
    deleteSession(id) {
      db.exec('BEGIN');
      db.prepare('DELETE FROM muse_requests WHERE binding_id IN (SELECT id FROM muse_bindings WHERE session_id = ?)').run(id);
      db.prepare('DELETE FROM muse_bindings WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM events WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM approvals WHERE session_id = ?').run(id);
      const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      db.exec('COMMIT');
      return result.changes > 0;
    },

    // After a host restart no engine is running and no approval can be answered.
    resetStale() {
      const now = new Date().toISOString();
      db.prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE status = 'running'").run(now);
      db.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending'").run(now);
    },

    close() {
      db.close();
    },
  };
}
