// Muse note save: creates one new small text file in a Muse-enabled project's inbox, no model call.
// The same policy that restricts a Muse session decides it, so the connector gains no new reach.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { decide, museFilenameError, museContentError, museConfig, projectRoot } from '../policy.mjs';

const error = (code, message) => ({ code, message });

export function createMuseFiles({ db, resolveProject, now = () => new Date().toISOString() }) {
  db.prepare("UPDATE muse_files SET state = 'uncertain', http_code = 503 WHERE state = 'running'").run();
  let writing = false;

  function replay(row) {
    const result = row.result ? JSON.parse(row.result) : {};
    const ok = row.state === 'completed';
    return { code: row.http_code || (ok ? 200 : 409), body: {
      ok, status: row.state === 'uncertain' ? 'unknown' : row.state, request_id: row.request_id,
      result: result.result ?? null, error: result.error ?? null,
    } };
  }
  const finish = (id, state, httpCode, payload) => db.prepare('UPDATE muse_files SET state = ?, http_code = ?, result = ? WHERE request_id = ?')
    .run(state, httpCode, JSON.stringify(payload), id);

  return {
    busy: () => writing,
    save(data) {
      const code = resolveProject(data.project);
      const muse = code && museConfig(code);
      if (!muse) return { code: 400, body: { ok: false, status: 'error', error: error('invalid_request', 'Unknown project.') } };
      const invalid = museFilenameError(data.filename) || museContentError(data.content);
      if (invalid) return { code: 400, body: { ok: false, status: 'error', error: error('invalid_file', invalid) } };
      const id = data.request_id;
      const payloadHash = createHash('sha256').update(JSON.stringify([code, data.filename, data.content])).digest('hex');
      const previous = db.prepare('SELECT * FROM muse_files WHERE request_id = ?').get(id);
      if (previous) {
        if (previous.payload_sha256 !== payloadHash) return { code: 409, body: { ok: false, status: 'error', error: error('request_conflict', 'request_id already belongs to different parameters.') } };
        return replay(previous);
      }
      if (writing) return { code: 409, body: { ok: false, status: 'error', error: error('busy', 'Another save is running.') } };
      writing = true;
      try {
        db.prepare("INSERT INTO muse_files (request_id, payload_sha256, state, created_at) VALUES (?, ?, 'running', ?)").run(id, payloadHash, now());
        const root = projectRoot(code);
        const target = path.join(root, muse.inbox, data.filename);
        const verdict = decide({ tool: 'write_file', args: { path: target, content: data.content } }, { project: code, profile: 'muse', engine: 'claude' });
        if (verdict.decision !== 'allow') {
          const exists = /already exists/.test(verdict.reason);
          finish(id, 'failed', exists ? 409 : 403, { error: exists ? error('file_exists', 'File already exists; choose a new filename and request ID.') : error('access_denied', 'File access denied.') });
        } else {
          let handle;
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            handle = fs.openSync(target, 'wx');
            fs.writeFileSync(handle, data.content, 'utf8');
            fs.fsyncSync(handle);
            finish(id, 'completed', 200, { result: { filename: data.filename, path: `${muse.inbox}/${data.filename}`, bytes: Buffer.byteLength(data.content), sha256: createHash('sha256').update(data.content).digest('hex') } });
          } catch (cause) {
            const exists = cause.code === 'EEXIST';
            finish(id, exists ? 'failed' : 'uncertain', exists ? 409 : 503, { error: exists ? error('file_exists', 'File already exists; nothing replaced.') : error('owner_review_required', 'File outcome uncertain. Inspect the project; do not resubmit.') });
          } finally { if (handle !== undefined) fs.closeSync(handle); }
        }
        return replay(db.prepare('SELECT * FROM muse_files WHERE request_id = ?').get(id));
      } finally { writing = false; }
    },
  };
}
