// Muse connector: a loopback listener that the buyer publishes with their own `tailscale serve`.
// Every request must pass the Host check, the Tailscale app-capability header and the bearer token.
// Chats bind once to a project; requests are idempotent by request_id (see connector/bindings.mjs).
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

import { getConfig } from './config.mjs';
import { getProject, museProjectCodes, redactGuarded } from './policy.mjs';
import { beginMuseTurn, endMuseTurn } from './tools.mjs';
import { createBindings, BindingError } from './connector/bindings.mjs';
import { createMuseFiles } from './connector/files.mjs';
import { buildOpenApi } from './connector/openapi.mjs';

const MAX_ASK_TEXT = 8000;
const MAX_REPLY_CHARS = 20000;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MUSE_TURN_MS = 180_000;
const turnMs = () => Number(process.env.KEELVANE_MUSE_TURN_MS) || MUSE_TURN_MS;

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      return resolve({ tooLarge: true });
    }
    let data = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) return;
      data += chunk;
      if (Buffer.byteLength(data) > limit) {
        tooLarge = true;
        data = '';
      }
    });
    req.on('end', () => resolve(tooLarge ? { tooLarge: true } : { data }));
    req.on('error', () => resolve({ error: true }));
  });
}

async function readJson(req, res, limit) {
  const read = await readBody(req, limit);
  if (read.tooLarge) return sendJson(res, 413, { ok: false, error: 'body too large' });
  if (read.error) return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
  let body;
  try { body = JSON.parse(read.data || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
  return body;
}

function safeEqualHex(actual, expectedHex) {
  if (typeof actual !== 'string' || !actual || !/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  const actualHash = createHash('sha256').update(actual).digest();
  const expected = Buffer.from(expectedHex, 'hex');
  return actualHash.length === expected.length && timingSafeEqual(actualHash, expected);
}

// A project is addressed by its code or its display name, case-insensitively.
function resolveProject(name) {
  if (typeof name !== 'string') return null;
  const lower = name.trim().toLowerCase();
  if (!lower) return null;
  return museProjectCodes().find((code) => code === lower || getProject(code)?.name.toLowerCase() === lower) ?? null;
}

// The Claude CLI runs each user turn through its prompt processor: an @path mention
// becomes a file read outside the Keelvane tools and a leading / is a command. A Muse turn
// reaches the engine behind a fixed label and with no @, checked after NFKC folds the
// full-width and small forms.
function museTurnText(text) {
  return `Muse request: ${text.normalize('NFKC').replace(/@/g, '(at)')}`;
}

function redactReply(text, session) {
  const redacted = redactGuarded(text, session);
  return redacted.length > MAX_REPLY_CHARS ? `${redacted.slice(0, MAX_REPLY_CHARS)}\n[reply truncated]` : redacted;
}

function connectorReady(c) {
  return Boolean(c.enabled && c.capability && c.serveHost && /^[0-9a-f]{64}$/.test(c.tokenSha256));
}

function startRemote({ store, ensureEngine, emit, port }) {
  const config = getConfig();
  const turnTimers = new Map();
  const bindings = createBindings({
    db: store.db,
    projects: config.projects,
    createSession: (code) => store.createSession({ project: code, engine: 'claude', model: 'sonnet', title: `Muse: ${getProject(code).name}`, profile: 'muse' }).id,
  });
  const files = createMuseFiles({ db: store.db, resolveProject });
  const anyMuseRunning = () => store.listSessions().some((row) => row.profile === 'muse' && row.status === 'running');

  let server = null;
  if (!connectorReady(config.connector)) {
    console.log('Muse connector off: set connector.serveHost, capability and tokenSha256 (remote-setup.mjs)');
  } else {
    server = http.createServer(museHandler);
    server.on('error', (error) => console.error(error));
    server.listen(port, '127.0.0.1', () => console.log(`Muse connector listening on http://127.0.0.1:${port}`));
  }

  function chatOutput(record, chatId) {
    const project = getProject(record.projectCode);
    const status = record.state === 'completed' ? 'idle' : record.state === 'accepted' ? 'running' : 'error';
    return {
      ok: true, chat_id: chatId, project: project?.name ?? record.projectCode, project_code: record.projectCode,
      request_id: record.requestId, status,
      reply: status === 'idle' ? record.result : null,
      error: record.state === 'uncertain' ? 'Interrupted outcome; check the session in Keelvane. Do not automatically resubmit.'
        : record.state === 'failed' ? record.result : null,
      reused: record.reused,
    };
  }

  async function museHandler(req, res) {
    try {
      const c = getConfig().connector;
      if (!connectorReady(c)) return sendJson(res, 503, { ok: false, error: 'Muse connector is off' });
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== c.serveHost && host !== `${c.serveHost}:8443`) return sendJson(res, 400, { ok: false, error: 'host denied' });
      if (req.headers['tailscale-user-login'] !== undefined) {
        return sendJson(res, 403, { ok: false, error: 'Muse must connect from a tagged Tailscale device' });
      }
      if (req.headers['tailscale-funnel-request'] !== undefined) {
        return sendJson(res, 403, { ok: false, error: 'funnel requests are not allowed' });
      }
      // Positive proof of the tagged device: Tailscale adds this header only for grants that name the capability.
      let caps = null;
      try { caps = JSON.parse(String(req.headers['tailscale-app-capabilities'] || '')); } catch { /* none */ }
      if (!caps || typeof caps !== 'object' || !Array.isArray(caps[c.capability])) {
        return sendJson(res, 403, { ok: false, error: 'Muse capability not granted to this device' });
      }
      let url;
      try { url = new URL(req.url, 'http://remote.invalid'); } catch { return sendJson(res, 400, { ok: false, error: 'bad request' }); }
      if (req.method === 'GET' && url.pathname === '/muse/v1/openapi.json') return sendJson(res, 200, buildOpenApi(c.serveHost));
      const auth = req.headers.authorization;
      const token = typeof auth === 'string' ? (/^Bearer\s+(\S+)\s*$/i.exec(auth)?.[1] ?? '') : '';
      if (!safeEqualHex(token, c.tokenSha256)) return sendJson(res, 401, { ok: false, error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });

      if (req.method === 'GET' && url.pathname === '/muse/v1/projects') {
        return sendJson(res, 200, { ok: true, projects: museProjectCodes().map((code) => ({ code, name: getProject(code).name })) });
      }
      if (req.method === 'GET' && url.pathname === '/muse/v1/status') {
        return sendJson(res, 200, { ok: true, status: anyMuseRunning() || files.busy() ? 'busy' : 'ready', observed_at: new Date().toISOString() });
      }
      if (req.method === 'POST' && url.pathname === '/muse/v1/chats/ask') return await handleAsk(req, res, c);
      if (req.method === 'GET' && url.pathname === '/muse/v1/chats/read') return handleRead(res, url);
      if (req.method === 'POST' && url.pathname === '/muse/v1/files') return await handleFiles(req, res, c);
      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
    }
  }

  async function handleFiles(req, res, c) {
    const data = await readJson(req, res, 16384);
    if (res.headersSent) return;
    const keys = ['project', 'request_id', 'filename', 'content'];
    if (Object.keys(data).some((k) => !keys.includes(k)) || typeof data.request_id !== 'string' || !REQUEST_ID.test(data.request_id)
      || typeof data.filename !== 'string' || typeof data.content !== 'string') {
      return sendJson(res, 400, { ok: false, error: 'Use project, request_id, filename and content only.' });
    }
    const result = files.save(data);
    return sendJson(res, result.code, result.body);
  }

  async function handleAsk(req, res, c) {
    const body = await readJson(req, res, c.maxBodyBytes);
    if (res.headersSent) return;
    if (Object.keys(body).some((k) => !['chat_id', 'request_id', 'project', 'text'].includes(k))) {
      return sendJson(res, 400, { ok: false, error: 'unexpected field' });
    }
    if (typeof body.chat_id !== 'string' || !body.chat_id.trim() || body.chat_id.length > 200
      || typeof body.request_id !== 'string' || !REQUEST_ID.test(body.request_id) || typeof body.text !== 'string') {
      return sendJson(res, 400, { ok: false, error: 'chat_id, request_id and text are required' });
    }
    // Folded first, so NFKC expansion (up to 18 characters from one) counts against the cap.
    const text = body.text.normalize('NFKC').trim();
    if (!text) return sendJson(res, 400, { ok: false, error: 'text is required' });
    if (text.length > MAX_ASK_TEXT) return sendJson(res, 413, { ok: false, error: 'text too long' });
    const projects = museProjectCodes();
    const project = body.project === undefined ? (projects.length === 1 ? projects[0] : null) : resolveProject(body.project);
    if (!project) return sendJson(res, 400, { ok: false, error: 'project not available to Muse' });

    let known = true;
    try { bindings.read({ chatId: body.chat_id, requestId: body.request_id }); } catch { known = false; }
    if (!known && anyMuseRunning()) return sendJson(res, 409, { ok: false, error: 'a Muse request is already running' });

    let record;
    try {
      record = bindings.accept({ chatId: body.chat_id, requestId: body.request_id, text, projectCode: project });
    } catch (error) {
      if (error instanceof BindingError) return sendJson(res, error.status, { ok: false, error: error.message });
      throw error;
    }
    if (!record.reused) {
      const session = store.getSession(record.sessionId);
      try {
        const handle = ensureEngine(session);
        const turn = museTurnText(text);
        emit(session.id, 'user_message', { text: turn, via: 'muse' });
        store.updateSession(session.id, { status: 'running' });
        beginMuseTurn(session.id, turnMs());
        armTurnTimeout(session.id, handle);
        handle.send(turn);
      } catch (error) {
        console.error(error);
        store.updateSession(session.id, { status: 'error' });
        bindings.fail(session.id, 'Keelvane could not start this request.');
        return sendJson(res, 500, { ok: false, error: 'Keelvane could not start this request' });
      }
    }
    return sendJson(res, record.reused ? 200 : 202, chatOutput(record, body.chat_id));
  }

  function handleRead(res, url) {
    if ([...url.searchParams.keys()].some((k) => !['chat_id', 'request_id'].includes(k))) return sendJson(res, 400, { ok: false, error: 'unexpected field' });
    const chatId = url.searchParams.get('chat_id');
    const requestId = url.searchParams.get('request_id');
    try {
      return sendJson(res, 200, chatOutput(bindings.read({ chatId, requestId }), chatId));
    } catch (error) {
      if (error instanceof BindingError) return sendJson(res, error.status === 400 ? 400 : 404, { ok: false, error: error.message });
      throw error;
    }
  }

  // Cancels only this Muse session's engine when its turn outlives the wall clock; owner sessions are untouched.
  function armTurnTimeout(sessionId, handle) {
    clearTimeout(turnTimers.get(sessionId));
    const timer = setTimeout(() => {
      turnTimers.delete(sessionId);
      const row = store.getSession(sessionId);
      if (!row || row.status !== 'running') return;
      endMuseTurn(sessionId);
      try { handle.kill(); } catch { /* already gone */ }
      emit(sessionId, 'error', { message: 'Muse request stopped: time limit reached' });
      store.updateSession(sessionId, { status: 'error' });
      bindings.uncertain(sessionId);
    }, turnMs());
    timer.unref();
    turnTimers.set(sessionId, timer);
  }

  function replyFor(session) {
    const events = store.listEvents(session.id);
    let lastUser = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].type === 'user_message') { lastUser = i; break; }
    }
    const parts = [];
    for (let i = lastUser + 1; i < events.length; i += 1) {
      if (events[i].type === 'text_delta' && typeof events[i].payload?.text === 'string') parts.push(events[i].payload.text);
    }
    return redactReply(parts.join(''), session);
  }

  // The server calls this for every engine event; only Muse sessions with an accepted request react.
  function onEngineEvent(sessionId, type) {
    if (type !== 'turn_finished' && type !== 'error') return;
    clearTimeout(turnTimers.get(sessionId));
    turnTimers.delete(sessionId);
    const session = store.getSession(sessionId);
    if (!session || session.profile !== 'muse') return;
    if (type === 'turn_finished') bindings.complete(sessionId, replyFor(session));
    else bindings.fail(sessionId, 'Keelvane hit an error on this request. Check the session in Keelvane.');
  }

  return {
    onEngineEvent,
    close() {
      for (const timer of turnTimers.values()) clearTimeout(timer);
      try { server?.close(); } catch { /* ignore */ }
    },
  };
}

export { startRemote, resolveProject, museTurnText };
