// Keelvane Harness host: HTTP API, static UI, and per-session SSE event stream.
// Browser safety: Host header must match,
// Origin if present must match, and every browser mutation needs
// X-Keelvane-Action: confirmed. POST /api/tool is authenticated by its per-session
// run token only, since it is called by the local MCP subprocess, not a browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { openStore } from './store.mjs';
import { runTool, endMuseTurn } from './tools.mjs';
import { listProjects, getProject, projectRoot, museConfig, decideFileChanges, dataDir } from './policy.mjs';
import { getConfig } from './config.mjs';
import { formatFileChanges } from './engines/codex.mjs';
import { createM4Routes } from './routes-m4.mjs';
import { startRemote } from './remote.mjs';
import { loadInstructions } from './instructions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.KEELVANE_PORT) || getConfig().ports.ui;
const CONNECTOR_PORT = Number(process.env.KEELVANE_CONNECTOR_PORT) || getConfig().ports.connector;
const FAKE_ENGINE = process.env.KEELVANE_FAKE_ENGINE === '1';
const HOST_URL = `http://127.0.0.1:${PORT}`;
const UI_DIR = path.join(__dirname, 'ui');
const MARKED_FILE = path.join(__dirname, 'node_modules', 'marked', 'lib', 'marked.esm.js');
const MODELS = {
  claude: new Set(['sonnet', 'opus', 'haiku']),
  codex: new Set(['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol']),
};
const MAX_TOOL_RESULT_CHARS = 8000;
const MAX_DIFF_CHARS = 20000;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

const allowedOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

const ENGINE_MODULES = FAKE_ENGINE
  ? { claude: await import('./engines/fake.mjs'), codex: await import('./engines/fake.mjs') }
  : { claude: await import('./engines/claude.mjs'), codex: await import('./engines/codex.mjs') };

const store = openStore();
let remote = null; // set once the listeners start; engine events reach it through handleEngineEvent
const engines = new Map(); // sessionId -> engine handle
const runTokens = new Map(); // sessionId -> run token
const subscribers = new Map(); // sessionId -> Set<ServerResponse>
const pendingApprovals = new Map(); // approvalId -> {sessionId, resolve, timer}

function broadcast(sessionId, event) {
  const set = subscribers.get(sessionId);
  if (!set || set.size === 0) return;
  const payload = `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      set.delete(res);
    }
  }
}

function emit(sessionId, type, payload) {
  const event = store.appendEvent(sessionId, type, payload);
  broadcast(sessionId, event);
  return event;
}

function truncate(value, max = MAX_TOOL_RESULT_CHARS) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

function handleEngineEvent(sessionId, type, payload) {
  emit(sessionId, type, payload);
  if (type === 'turn_finished' || type === 'error') endMuseTurn(sessionId); // no-op for owner sessions
  if (type === 'turn_finished') {
    const patch = { status: 'idle' };
    if (payload?.engine_session_id) patch.engine_session_id = payload.engine_session_id;
    store.updateSession(sessionId, patch);
  } else if (type === 'error') {
    store.updateSession(sessionId, { status: 'error' });
  }
  remote?.onEngineEvent(sessionId, type);
}

// ---- HTTP helpers ----------------------------------------------------

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function validHost(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}

function originOk(req) {
  const value = req.headers.origin;
  if (!value) return true;
  return allowedOrigins.has(value);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      return send(res, 404, { ok: false, error: 'not found' });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // Model markdown is rendered as HTML; this CSP keeps any injected markup from running
      // script (which could approve its own tool calls) or loading outside resources.
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    res.end(data);
  });
}

function serveStatic(res, route) {
  if (route === '/vendor/marked.esm.js') return serveFile(res, MARKED_FILE);
  const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
  const target = path.resolve(UI_DIR, rel);
  const uiRootLower = UI_DIR.toLowerCase();
  if (target.toLowerCase() !== uiRootLower && !target.toLowerCase().startsWith(uiRootLower + path.sep)) {
    return send(res, 400, { ok: false, error: 'bad path' });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return send(res, 404, { ok: false, error: 'not found' });
  }
  serveFile(res, target);
}

// ---- Session/session-scoped route matchers ----------------------------

const MESSAGES_RE = /^\/api\/sessions\/([^/]+)\/messages$/;
const EVENTS_RE = /^\/api\/sessions\/([^/]+)\/events$/;
const STOP_RE = /^\/api\/sessions\/([^/]+)\/stop$/;
const ARCHIVE_RE = /^\/api\/sessions\/([^/]+)\/archive$/;
const RENAME_RE = /^\/api\/sessions\/([^/]+)\/rename$/;
const DELETE_RE = /^\/api\/sessions\/([^/]+)$/;
const APPROVALS_RE = /^\/api\/sessions\/([^/]+)\/approvals\/([^/]+)$/;

function sanitizeSession(row) {
  if (!row) return row;
  const { ...rest } = row;
  return rest; // run tokens are never stored on the row itself
}

// ---- Approvals ----------------------------------------------------------

function requestApproval(sessionId, tool, args, info) {
  const summary = tool === 'run_command' ? args.command : tool === 'git_commit' ? `git_commit ${args.message}` : `${tool} ${args.path ?? ''}`;
  const approval = store.createApproval({ sessionId, tool, summary });
  emit(sessionId, 'approval_requested', {
    approval_id: approval.id,
    tool,
    args,
    reason: info.reason,
    target: info.target,
    preview: info.preview,
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(approval.id);
      store.updateApproval(approval.id, { status: 'expired' });
      emit(sessionId, 'approval_resolved', { approval_id: approval.id, decision: 'expired' });
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(approval.id, { sessionId, resolve, timer });
  });
}

function settleApproval(approvalId, decision) {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingApprovals.delete(approvalId);
  store.updateApproval(approvalId, { status: decision === 'approve' ? 'approved' : 'denied' });
  emit(pending.sessionId, 'approval_resolved', { approval_id: approvalId, decision });
  pending.resolve(decision === 'approve');
  return true;
}

function settleSessionApprovals(sessionId) {
  for (const [approvalId, pending] of pendingApprovals) {
    if (pending.sessionId !== sessionId) continue;
    clearTimeout(pending.timer);
    pendingApprovals.delete(approvalId);
    store.updateApproval(approvalId, { status: 'denied' });
    emit(sessionId, 'approval_resolved', { approval_id: approvalId, decision: 'deny' });
    pending.resolve(false);
  }
}

// Codex apply_patch: the same policy as write_file/edit_file, decided before
// Codex writes anything. Returns { ok, reason } for the adapter.
async function reviewFileChange(session, changes) {
  const tool = 'apply_patch';
  let paths = [];
  let diff = '';
  try {
    ({ paths, diff } = formatFileChanges(changes, projectRoot(session.project)));
  } catch {} // malformed changes are denied by decideFileChanges below
  const args = { path: paths.join(', ') };
  emit(session.id, 'tool_started', { tool, args });
  const verdict = decideFileChanges(changes, session);
  let ok = verdict.decision === 'allow';
  let error = `denied: ${verdict.reason}`;
  if (verdict.decision === 'ask') {
    ok = await requestApproval(session.id, tool, args, { reason: verdict.reason, target: args.path, preview: truncate(diff, MAX_DIFF_CHARS) });
    error = 'denied by the user';
  }
  emit(session.id, 'tool_finished', ok
    ? { tool, args, ok, result: `patch accepted: ${paths.length} file(s)`, diff: truncate(diff, MAX_DIFF_CHARS) }
    : { tool, args, ok, error });
  return { ok, reason: ok ? undefined : error };
}

// ---- Engine helpers ------------------------------------------------------

function ensureEngine(session) {
  const existing = engines.get(session.id);
  if (existing && !existing.exited) return existing; // a crashed or killed engine gets replaced
  const runToken = randomBytes(24).toString('hex');
  runTokens.set(session.id, runToken);
  const root = projectRoot(session.project);
  const { startEngine } = ENGINE_MODULES[session.engine] || ENGINE_MODULES.claude;
  const handle = startEngine(
    {
      sessionId: session.id,
      projectRoot: root,
      instructions: loadInstructions(root, session.engine),
      model: session.model,
      runToken,
      hostUrl: HOST_URL,
      dataDir: dataDir(),
      museInbox: museConfig(session.project)?.inbox,
      resumeId: session.engine_session_id || null,
      reviewFileChange: (changes) => reviewFileChange(session, changes),
      profile: session.profile,
    },
    (type, payload) => handleEngineEvent(session.id, type, payload)
  );
  engines.set(session.id, handle);
  return handle;
}

// ---- Route handlers -----------------------------------------------------

async function handleListSessions(req, res) {
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' }), true;
  const sessions = store.listSessions().map((row) => ({ ...sanitizeSession(row), pending_approvals: m4.countPending(row.id) }));
  return send(res, 200, { ok: true, sessions }), true;
}

async function handleCreateSession(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return false;
  if (req.method === 'GET') return handleListSessions(req, res);
  if (req.headers['x-keelvane-action'] !== 'confirmed') return send(res, 403, { ok: false, error: 'action denied' }), true;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return send(res, 400, { ok: false, error: error.message }), true;
  }
  const project = String(body.project || '');
  const known = getProject(project);
  if (!known) {
    return send(res, 400, { ok: false, error: `unknown project: ${project}` }), true;
  }
  const engine = String(body.engine || known.engine);
  if (!Object.prototype.hasOwnProperty.call(MODELS, engine)) {
    return send(res, 400, { ok: false, error: `unknown engine: ${engine}` }), true;
  }
  const model = String(body.model || '');
  if (!MODELS[engine].has(model)) {
    return send(res, 400, { ok: false, error: `unknown model: ${model}` }), true;
  }
  const session = store.createSession({ project, engine, model, title: body.title ? String(body.title).slice(0, 200) : null });
  ensureEngine(session);
  return send(res, 200, { ok: true, session: sanitizeSession(session) }), true;
}

const preparingSessions = new Set();
async function handleMessages(req, res, id) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' }), true;
  if (req.headers['x-keelvane-action'] !== 'confirmed') return send(res, 403, { ok: false, error: 'action denied' }), true;
  const session = store.getSession(id);
  if (!session) return send(res, 404, { ok: false, error: 'session not found' }), true;
  if (session.profile === 'muse') return send(res, 403, { ok: false, error: 'Muse sessions take messages only from Muse' }), true;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return send(res, 400, { ok: false, error: error.message }), true;
  }
  const current=store.getSession(id);
  if(current.archived || current.status==='running' || m4.countPending(id)>0 || preparingSessions.has(id)) {
    return send(res,409,{ok:false,error:'session busy, archived or awaiting approval'}),true;
  }
  preparingSessions.add(id);
  try {
  let prepared;
  try {
    prepared = await m4.prepareMessage(session, body);
  } catch (error) {
    return send(res, error.status || 400, { ok: false, error: error.message }), true;
  }
  const { payload, engineText } = prepared;
  const handle=ensureEngine(current);
  emit(id, 'user_message', payload);
  const title = session.title || `${payload.skill ? `/${payload.skill} ` : ''}${payload.text}`.replace(/\s+/g, ' ').trim().slice(0, 60);
  store.updateSession(id, title ? { status: 'running', title } : { status: 'running' });
  try { handle.send(engineText); }
  catch (error) { store.updateSession(id, {status: 'error'}); throw error; }
  return send(res, 202, { ok: true }), true;
  } finally { preparingSessions.delete(id); }
}

async function handleEvents(req, res, id, url) {
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' }), true;
  const session = store.getSession(id);
  if (!session) return send(res, 404, { ok: false, error: 'session not found' }), true;
  const after = Number(url.searchParams.get('after')) || 0;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  for (const event of store.listEvents(id, after)) {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  let set = subscribers.get(id);
  if (!set) {
    set = new Set();
    subscribers.set(id, set);
  }
  set.add(res);
  req.on('close', () => {
    set.delete(res);
  });
  return true;
}

async function handleStop(req, res, id) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' }), true;
  if (req.headers['x-keelvane-action'] !== 'confirmed') return send(res, 403, { ok: false, error: 'action denied' }), true;
  const session = store.getSession(id);
  if (!session) return send(res, 404, { ok: false, error: 'session not found' }), true;
  const handle = engines.get(id);
  if (!handle) return send(res, 404, { ok: false, error: 'engine is not running for this session' }), true;
  settleSessionApprovals(id);
  endMuseTurn(id);
  await handle.interrupt();
  return send(res, 202, { ok: true }), true;
}

async function handleArchive(req, res, id) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' }), true;
  if (req.headers['x-keelvane-action'] !== 'confirmed') return send(res, 403, { ok: false, error: 'action denied' }), true;
  const session = store.getSession(id);
  if (!session) return send(res, 404, { ok: false, error: 'session not found' }), true;
  if (session.status === 'running') return send(res, 409, { ok: false, error: 'stop the session before archiving it' }), true;
  const handle = engines.get(id);
  if (handle) handle.kill();
  engines.delete(id);
  store.updateSession(id, { archived: 1 });
  return send(res, 200, { ok: true }), true;
}

async function handleRename(req, res, id) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' }), true;
  if (req.headers['x-keelvane-action'] !== 'confirmed') return send(res, 403, { ok: false, error: 'action denied' }), true;
  const session = store.getSession(id);
  if (!session) return send(res, 404, { ok: false, error: 'session not found' }), true;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return send(res, 400, { ok: false, error: error.message }), true;
  }
  const title = String(body.title || '').trim().slice(0, 200);
  if (!title) return send(res, 400, { ok: false, error: 'title required' }), true;
  store.updateSession(id, { title });
  return send(res, 200, { ok: true }), true;
}

async function handleDelete(req, res, id) {
  if (req.method !== 'DELETE') return false;
  if (req.headers['x-keelvane-action'] !== 'confirmed') return send(res, 403, { ok: false, error: 'action denied' }), true;
  const session = store.getSession(id);
  if (!session) return send(res, 404, { ok: false, error: 'session not found' }), true;
  if (session.status === 'running') return send(res, 409, { ok: false, error: 'stop the session before deleting it' }), true;
  const handle = engines.get(id);
  if (handle) handle.kill();
  engines.delete(id);
  store.deleteSession(id);
  return send(res, 200, { ok: true }), true;
}

async function handleApproval(req, res, sessionId, approvalId) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' }), true;
  if (req.headers['x-keelvane-action'] !== 'confirmed') return send(res, 403, { ok: false, error: 'action denied' }), true;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return send(res, 400, { ok: false, error: error.message }), true;
  }
  const decision = body.decision;
  if (decision !== 'approve' && decision !== 'deny') {
    return send(res, 400, { ok: false, error: 'decision must be approve or deny' }), true;
  }
  const pending = pendingApprovals.get(approvalId);
  if (!pending || pending.sessionId !== sessionId) {
    return send(res, 404, { ok: false, error: 'approval not found' }), true;
  }
  settleApproval(approvalId, decision);
  return send(res, 200, { ok: true }), true;
}

async function handleTool(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' }), true;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return send(res, 400, { ok: false, error: error.message }), true;
  }
  const sessionId = String(body.session_id || '');
  const token = req.headers['x-keelvane-run-token'];
  const expected = runTokens.get(sessionId);
  if (!expected || typeof token !== 'string' || Buffer.byteLength(token) !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return send(res, 401, { ok: false, error: 'invalid run token' }), true;
  }
  const session = store.getSession(sessionId);
  if (!session) return send(res, 404, { ok: false, error: 'session not found' }), true;
  const tool = String(body.tool || '');
  const args = body.args && typeof body.args === 'object' ? body.args : {};
  emit(sessionId, 'tool_started', { tool, args });
  const result = await runTool(tool, args, session, {
    approve: (info) => requestApproval(sessionId, tool, args, info),
  });
  const finishedPayload = {
    tool,
    args,
    ok: result.ok,
    result: result.ok ? truncate(result.result) : undefined,
    error: result.ok ? undefined : result.error,
  };
  if (result.ok && result.diff) {
    finishedPayload.diff = truncate(result.diff, MAX_DIFF_CHARS);
  }
  emit(sessionId, 'tool_finished', finishedPayload);
  return send(res, result.ok ? 200 : 400, result), true;
}

// ---- Server ---------------------------------------------------------------

const m4 = createM4Routes({ store, pendingApprovals, send, readJsonBody });

store.resetStale();

async function handleRequest(req, res) {
  let route;
  let url;
  try {
    url = new URL(req.url, HOST_URL);
    route = url.pathname;
  } catch {
    return send(res, 400, { ok: false, error: 'bad request' });
  }

  if (!validHost(req)) return send(res, 400, { ok: false, error: 'host denied' });
  if (!originOk(req)) return send(res, 403, { ok: false, error: 'origin denied' });

  try {
    if (await m4.handle(req, res, route, url)) return;
    if (route === '/api/projects' && req.method === 'GET') {
      return send(res, 200, { ok: true, projects: listProjects().map(({ code, name, engine, private: isPrivate }) => ({ code, name, engine, private: isPrivate })) });
    }
    if (route === '/api/sessions') {
      if (await handleCreateSession(req, res)) return;
    }
    if (route === '/api/tool') {
      if (await handleTool(req, res)) return;
    }
    const messagesMatch = MESSAGES_RE.exec(route);
    if (messagesMatch) {
      if (await handleMessages(req, res, messagesMatch[1])) return;
    }
    const eventsMatch = EVENTS_RE.exec(route);
    if (eventsMatch) {
      if (await handleEvents(req, res, eventsMatch[1], url)) return;
    }
    const stopMatch = STOP_RE.exec(route);
    if (stopMatch) {
      if (await handleStop(req, res, stopMatch[1])) return;
    }
    const archiveMatch = ARCHIVE_RE.exec(route);
    if (archiveMatch) {
      if (await handleArchive(req, res, archiveMatch[1])) return;
    }
    const renameMatch = RENAME_RE.exec(route);
    if (renameMatch) {
      if (await handleRename(req, res, renameMatch[1])) return;
    }
    const deleteMatch = DELETE_RE.exec(route);
    if (deleteMatch) {
      if (await handleDelete(req, res, deleteMatch[1])) return;
    }
    const approvalsMatch = APPROVALS_RE.exec(route);
    if (approvalsMatch) {
      if (await handleApproval(req, res, approvalsMatch[1], approvalsMatch[2])) return;
    }
  } catch (error) {
    return send(res, 500, { ok: false, error: String(error.message || error) });
  }

  if (req.method === 'GET' && (route === '/' || !route.startsWith('/api/'))) {
    return serveStatic(res, route);
  }

  return send(res, 404, { ok: false, error: 'unknown route' });
}

const server = http.createServer(handleRequest);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Keelvane Harness listening on http://127.0.0.1:${PORT}${FAKE_ENGINE ? ' (fake engine)' : ''}`);
});

remote = startRemote({ store, ensureEngine, emit, port: CONNECTOR_PORT });

function shutdown() {
  for (const handle of engines.values()) {
    try {
      handle.kill();
    } catch {
      /* ignore */
    }
  }
  try {
    store.close();
  } catch {
    /* ignore */
  }
  try {
    remote?.close();
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
