import fs from 'node:fs';
import path from 'node:path';
import { listSkills, loadSkill } from './skills.mjs';
import { repoRootFor, gitStatus, gitDiff, gitCommit } from './git.mjs';
import { projectRoot, attachmentsDir, isInside, isCredentialPath } from './policy.mjs';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function createM4Routes({ store, pendingApprovals, send, readJsonBody }) {
  function countPending(sessionId) {
    let count = 0;
    for (const entry of pendingApprovals.values()) {
      if (entry.sessionId === sessionId) count += 1;
    }
    return count;
  }

  function requireAction(req, res) {
    if (req.headers['x-keelvane-action'] !== 'confirmed') {
      send(res, 403, { ok: false, error: 'action denied' });
      return false;
    }
    return true;
  }

  function getSessionOr404(req, res, id) {
    const session = store.getSession(id);
    if (!session) {
      send(res, 404, { ok: false, error: 'session not found' });
      return null;
    }
    return session;
  }

  async function handleSkills(req, res) {
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' }), true;
    const skills = listSkills().map(({ name, description, source, unsupported }) => ({
      name,
      description,
      source,
      unsupported,
    }));
    send(res, 200, { ok: true, skills });
    return true;
  }

  async function handleGitStatus(req, res, session) {
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' }), true;
    const scopeAbs = projectRoot(session.project);
    const repoRoot = await repoRootFor(scopeAbs);
    const status = await gitStatus({ repoRoot, scopeAbs });
    send(res, 200, { ok: true, ...status });
    return true;
  }

  async function handleGitDiff(req, res, session, url) {
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' }), true;
    const scopeAbs = projectRoot(session.project);
    const repoRoot = await repoRootFor(scopeAbs);
    const diff = await gitDiff({
      repoRoot,
      scopeAbs,
      path: url.searchParams.get('path') || undefined,
    });
    send(res, 200, { ok: true, diff });
    return true;
  }

  async function handleGitCommit(req, res, session) {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' }), true;
    if (!requireAction(req, res)) return true;
    if (session.status === 'running') {
      return send(res, 409, { ok: false, error: 'session is running; wait for the turn to finish' }), true;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return send(res, 400, { ok: false, error: error.message }), true;
    }
    const scopeAbs = projectRoot(session.project);
    const repoRoot = await repoRootFor(scopeAbs);
    const result = await gitCommit({
      repoRoot,
      scopeAbs,
      paths: body.paths,
      message: body.message,
    });
    send(res, 200, { ok: true, ...result });
    return true;
  }

  function sanitizeName(rawName) {
    let name = String(rawName || '').replace(/\\/g, '/');
    name = path.basename(name);
    name = name.replace(/[^A-Za-z0-9._ -]/g, '_');
    name = name.replace(/_+/g, '_');
    name = name.replace(/^[. ]+|[. ]+$/g, '');
    name = name.slice(0, 100);
    return name || 'file';
  }

  async function handleAttachments(req, res, session, url) {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' }), true;
    if (!requireAction(req, res)) return true;

    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) {
      req.resume();
      send(res, 413, { ok: false, error: 'attachment exceeds 20 MB' });
      return true;
    }

    const safeName = sanitizeName(url.searchParams.get('name'));
    const dir = attachmentsDir(session.id);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${Date.now()}-${safeName}`);

    if (isCredentialPath(filePath)) {
      req.resume();
      send(res, 400, { ok: false, error: 'that file name looks like a credential file; rename it before attaching' });
      return true;
    }

    let size = 0;
    let overflow = false;
    let writeStream;

    const cleanup = () => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // already gone
      }
    };

    try {
      writeStream = fs.createWriteStream(filePath);
      await new Promise((resolve, reject) => {
        writeStream.on('error', reject);
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_ATTACHMENT_BYTES) {
            if (!overflow) {
              overflow = true;
              writeStream.destroy();
            }
            // ponytail: drain up to 2x the cap so the client can read the 413; past that, cut the socket.
            if (size > 2 * MAX_ATTACHMENT_BYTES) req.destroy();
            return;
          }
          writeStream.write(chunk);
        });
        req.on('end', () => {
          if (overflow) resolve();
          else writeStream.end(() => resolve());
        });
        // A client that disconnects mid-upload must not leave a partial file that looks complete.
        req.on('close', () => {
          if (!req.complete && !overflow) reject(new Error('upload interrupted'));
          else if (overflow) resolve();
        });
        req.on('error', reject);
      });

      if (overflow) {
        // Unlink only after close: the stream may still have been opening the file.
        if (!writeStream.closed) await new Promise((r) => writeStream.once('close', r));
        cleanup();
        if (!res.destroyed) send(res, 413, { ok: false, error: 'attachment exceeds 20 MB' });
        return true;
      }

      if (size === 0) {
        cleanup();
        send(res, 400, { ok: false, error: 'empty file' });
        return true;
      }

      send(res, 200, { ok: true, name: safeName, path: filePath, size });
      return true;
    } catch (error) {
      writeStream?.once('close', cleanup);
      writeStream?.destroy();
      cleanup();
      if (!res.headersSent && !res.destroyed) send(res, 500, { ok: false, error: error.message });
      return true;
    }
  }

  async function handle(req, res, route, url) {
    try {
      if (route === '/api/skills') return await handleSkills(req, res);

      let match = route.match(/^\/api\/sessions\/([^/]+)\/git$/);
      if (match) {
        const session = getSessionOr404(req, res, match[1]);
        if (!session) return true;
        return await handleGitStatus(req, res, session);
      }

      match = route.match(/^\/api\/sessions\/([^/]+)\/git\/diff$/);
      if (match) {
        const session = getSessionOr404(req, res, match[1]);
        if (!session) return true;
        return await handleGitDiff(req, res, session, url);
      }

      match = route.match(/^\/api\/sessions\/([^/]+)\/git\/commit$/);
      if (match) {
        const session = getSessionOr404(req, res, match[1]);
        if (!session) return true;
        return await handleGitCommit(req, res, session);
      }

      match = route.match(/^\/api\/sessions\/([^/]+)\/attachments$/);
      if (match) {
        const session = getSessionOr404(req, res, match[1]);
        if (!session) return true;
        return await handleAttachments(req, res, session, url);
      }

      return false;
    } catch (error) {
      const status = typeof error.status === 'number' ? error.status : 500;
      send(res, status, { ok: false, error: error.message });
      return true;
    }
  }

  function prepareMessage(session, body) {
    const text = String(body.text || '').trim();

    let skill = null;
    if (body.skill !== undefined && body.skill !== null) {
      if (typeof body.skill !== 'string') {
        const error = new Error('skill must be a string');
        error.status = 400;
        throw error;
      }
      skill = loadSkill(body.skill);
      if (!skill) {
        const error = new Error(`unknown skill: ${body.skill}`);
        error.status = 400;
        throw error;
      }
    }

    let attachments = null;
    if (body.attachments !== undefined && body.attachments !== null) {
      if (!Array.isArray(body.attachments) || body.attachments.length > 10) {
        const error = new Error('attachments must be an array of at most 10 items');
        error.status = 400;
        throw error;
      }
      const uploadDir = attachmentsDir(session.id);
      attachments = body.attachments.map((item) => {
        if (!item || typeof item !== 'object' || typeof item.path !== 'string') {
          const error = new Error('each attachment must have a string path');
          error.status = 400;
          throw error;
        }
        const abs = path.resolve(item.path);
        if (!isInside(uploadDir, abs) || abs === uploadDir) {
          const error = new Error("attachment is not in this session's upload folder");
          error.status = 400;
          throw error;
        }
        let stat;
        try {
          stat = fs.statSync(abs);
        } catch {
          const error = new Error(`attachment not found: ${path.basename(abs)}`);
          error.status = 400;
          throw error;
        }
        if (!stat.isFile()) {
          const error = new Error(`attachment not found: ${path.basename(abs)}`);
          error.status = 400;
          throw error;
        }
        return {
          name: String(item.name || path.basename(abs)).slice(0, 200),
          path: abs,
          size: stat.size,
        };
      });
    }

    if (!text && !skill && !attachments) {
      const error = new Error('text is required');
      error.status = 400;
      throw error;
    }

    let engineText = '';
    if (skill) {
      const skillDir = skill.dir.split(path.sep).join('/');
      engineText += `The user invoked the "${skill.name}" skill. Its instructions follow; apply them to this request. Files it references live in ${skillDir}.\n`;
      engineText += `<skill name="${skill.name}">\n${skill.text}\n</skill>\n\n`;
      engineText += text || '(no further instructions)';
    } else {
      engineText = text;
    }

    if (attachments) {
      engineText += '\n\nAttached files (read them with read_file):\n';
      for (const attachment of attachments) {
        const displayPath = attachment.path.split(path.sep).join('/');
        engineText += `- ${displayPath} (${attachment.size} bytes)\n`;
      }
    }

    const payload = { text };
    if (skill) payload.skill = skill.name;
    if (attachments) payload.attachments = attachments;

    return { engineText, payload };
  }

  return { handle, prepareMessage, countPending };
}
