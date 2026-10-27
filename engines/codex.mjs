// Codex engine adapter: one long-lived `codex.exe` process per session,
// driven with newline-delimited JSON-RPC over stdio.
// Protocol shapes verified against the Codex app-server interface in the
// contract; the adapter only forwards text deltas and turn lifecycle events.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.mjs';

const TOOLS_MCP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools-mcp.mjs');

export const MCP_SERVER_NAME = 'keelvane';
const INTERRUPT_TIMEOUT_MS = 5000;
const STDERR_TAIL_LIMIT = 4000;
const STDERR_ERROR_TAIL = 500;
const MAX_INPUT_IMAGES = 4;
const MAX_INPUT_IMAGE_BYTES = 5 * 1024 * 1024;
const INPUT_IMAGE_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif'],
]);

function prepareScopedImageInputs(images, dataDir) {
  if (!Array.isArray(images) || images.length > MAX_INPUT_IMAGES) throw new Error('Codex accepts at most four input images');
  if (images.length && !dataDir) throw new Error('Codex image attachments require a runtime data directory');
  const created = [];
  try {
    const inputs = images.map((image) => {
      const extension = INPUT_IMAGE_EXTENSIONS.get(image?.mimeType);
      const data = image?.data;
      if (!extension) throw new Error('Codex image attachment has an unsupported MIME type');
      if (typeof data !== 'string' || !data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        throw new Error('Codex image attachment has invalid base64 data');
      }
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > MAX_INPUT_IMAGE_BYTES) throw new Error('Codex image attachment exceeds 5 MiB');
      if (bytes.toString('base64') !== data) throw new Error('Codex image attachment has invalid base64 data');
      const imagePath = path.join(dataDir, `codex-input-${randomUUID()}.${extension}`);
      writeFileSync(imagePath, bytes, { flag: 'wx', mode: 0o600 });
      created.push(imagePath);
      return { type: 'localImage', path: imagePath };
    });
    return { inputs, cleanup: () => { for (const imagePath of created) rmSync(imagePath, { force: true }); } };
  } catch (error) {
    for (const imagePath of created) rmSync(imagePath, { force: true });
    throw error;
  }
}

// Codex tools that must stay disabled so the harness is the only way to touch
// the project. code_mode_host is intentionally NOT in this list: every Codex
// tool call, including the Keelvane MCP tools, runs through it.
const DISABLED_TOOLS = [
  'shell_tool',
  'unified_exec',
  'goals',
  'view_image',
  'image_generation',
  'multi_agent',
  'apps',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'computer_use',
  'plugins',
  'hooks',
  'sleep_tool',
  'tool_suggest',
  'skill_mcp_dependency_install',
  'remote_plugin',
  'realtime_conversation',
];

const DEVELOPER_INSTRUCTIONS = (projectRoot) => `Your session project is ${projectRoot}. Use the keelvane tools to read, search, write and edit files, and pass paths relative to that folder. apply_patch changes are checked by the same Keelvane policy. Do not spawn sub-agents.`;

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function tomlString(value) {
  // JSON.stringify produces valid TOML basic strings for the values we emit.
  return JSON.stringify(value);
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function findCodexBin() {
  if (process.env.KEELVANE_CODEX_BIN) return process.env.KEELVANE_CODEX_BIN;
  const configured = getConfig().engines.codex.bin;
  if (configured && configured !== 'auto') return configured;
  const binRoot = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  let newest = null;
  let newestMtime = 0;
  try {
    for (const folder of readdirSync(binRoot)) {
      const candidate = path.join(binRoot, folder, 'codex.exe');
      try {
        const mtime = statSync(candidate).mtimeMs;
        if (mtime > newestMtime) {
          newestMtime = mtime;
          newest = candidate;
        }
      } catch {
        // Folder without codex.exe; keep looking.
      }
    }
  } catch {
    // No bin directory at all.
  }
  return newest;
}

export function listAmbientMcpServers(tomlText) {
  const servers = new Map();
  let currentName = null;
  let currentHasUrl = false;
  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      // Any header ends the current server's body; sub-tables like
      // [mcp_servers.x.env] are not servers and their keys are never read.
      if (currentName && !servers.has(currentName)) {
        servers.set(currentName, { name: currentName, transport: currentHasUrl ? 'url' : 'command' });
      }
      const m = line.match(/^\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/);
      currentName = m ? (m[1] ?? m[2]) : null;
      currentHasUrl = false;
      continue;
    }
    if (currentName && /^url\s*=/.test(line)) currentHasUrl = true;
  }
  if (currentName && !servers.has(currentName)) {
    servers.set(currentName, { name: currentName, transport: currentHasUrl ? 'url' : 'command' });
  }
  return [...servers.values()];
}

export function readAmbientMcpServers() {
  const configPath = path.join(codexHome(), 'config.toml');
  try {
    return listAmbientMcpServers(readFileSync(configPath, 'utf8'));
  } catch {
    return [];
  }
}

export function buildCodexArgs({ ambient, nodePath, toolsMcpPath }) {
  const args = ['app-server'];
  for (const tool of DISABLED_TOOLS) args.push('--disable', tool);
  args.push('-c', 'web_search="disabled"');
  args.push('-c', 'sandbox_mode="read-only"');
  args.push('-c', 'notify=[]'); // the user config's notify command must not run from a Keelvane session
  for (const server of ambient) {
    if (server.name === MCP_SERVER_NAME) continue; // ours replaces it
    if (!/^[A-Za-z0-9_-]+$/.test(server.name)) {
      throw new Error(`ambient MCP server "${server.name}" cannot be disabled safely`);
    }
    if (server.transport === 'url') {
      args.push('-c', `mcp_servers.${server.name}={url="http://127.0.0.1:1/mcp", enabled=false}`);
    } else {
      args.push('-c', `mcp_servers.${server.name}={command="true", enabled=false}`);
    }
  }
  args.push(
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}={command=${tomlString(nodePath)}, args=[${tomlString(toolsMcpPath)}], env_vars=["KEELVANE_SESSION_ID","KEELVANE_RUN_TOKEN","KEELVANE_HOST_URL"], tool_timeout_sec=900}`,
  );
  return args;
}

function displayPath(absPath, root) {
  const rel = path.relative(root, absPath);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  return (inside ? rel : absPath).split(path.sep).join('/');
}

export function formatFileChanges(changes, root) {
  const paths = changes.map((change) => displayPath(change.path, root));
  const diffs = changes.map((change, i) => {
    const rel = paths[i];
    const headerPath = change.kind.type === 'update' && change.kind.move_path
      ? displayPath(change.kind.move_path, root)
      : rel;
    const lines = ['--- a/' + rel, '+++ b/' + headerPath];
    if (change.kind.type === 'add') {
      const contentLines = change.diff.replace(/\n$/, '').split('\n');
      lines.push(`@@ -0,0 +1,${contentLines.length} @@`);
      for (const line of contentLines) lines.push('+' + line);
    } else if (change.kind.type === 'delete') {
      const contentLines = change.diff.replace(/\n$/, '').split('\n');
      lines.push(`@@ -1,${contentLines.length} +0,0 @@`);
      for (const line of contentLines) lines.push('-' + line);
    } else {
      lines.push(change.diff.replace(/\n$/, ''));
    }
    return lines.join('\n');
  });
  return { paths, diff: diffs.join('\n') };
}

export function startEngine(opts, onEvent) {
  const { sessionId, projectRoot, model, runToken, hostUrl, dataDir, resumeId, reviewFileChange, codexCommand, instructions = '' } = opts;

  const codexBin = codexCommand ? null : findCodexBin();
  if (!codexCommand && !codexBin) {
    const message = 'codex.exe not found; set KEELVANE_CODEX_BIN';
    onEvent('error', { message });
    return {
      get exited() {
        return true;
      },
      send() {
        onEvent('error', { message });
      },
      interrupt() {
        return Promise.resolve();
      },
      kill() {},
    };
  }

  const [file, ...extraArgs] = codexCommand || [codexBin];
  let args;
  try {
    args = [...extraArgs, ...buildCodexArgs({
      ambient: readAmbientMcpServers(),
      nodePath: process.execPath,
      toolsMcpPath: TOOLS_MCP_PATH,
    })];
  } catch (error) {
    onEvent('error', { message: error.message });
    return { get exited() { return true; }, send() { onEvent('error', { message: error.message }); }, interrupt: () => Promise.resolve(), kill() {} };
  }

  // The run token travels in the env, never on the command line; env_vars
  // in the keelvane entry forwards these three to the MCP server.
  const env = { ...process.env, KEELVANE_SESSION_ID: sessionId, KEELVANE_RUN_TOKEN: runToken, KEELVANE_HOST_URL: hostUrl };
  const child = spawn(file, args, { cwd: projectRoot, windowsHide: true, env });

  let exited = false;
  let killedByUs = false;
  let nextId = 1;
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => {}); // startup errors are reported once, below; never an unhandled rejection
  let turnDone = null; // resolves the queued send when its turn completes or the process exits
  let turnStarting = null; // the in-flight turn/start request
  let threadId = null;
  let currentTurnId = null;
  let turnUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  let agentMessageProducedText = false;
  const fileChanges = new Map();
  let turnQueue = Promise.resolve();
  let interruptResolve = null;
  let interruptTimer = null;
  let stderrTail = '';

  // Message shapes as verified live: no "jsonrpc" field.
  function write(message) {
    if (exited) return false;
    try {
      child.stdin.write(JSON.stringify(message) + '\n');
      return true;
    } catch {
      return false; // process is gone; the exit handler cleans up
    }
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      if (!write({ id, method, params })) {
        pending.delete(id);
        reject(new Error('engine process has already exited'));
      }
    });
  }

  const notify = (method, params) => write({ method, params });
  const respond = (id, result) => write({ id, result });
  const respondError = (id, message) => write({ id, error: { code: -32601, message } });

  function endTurn() {
    currentTurnId = null;
    turnUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    agentMessageProducedText = false;
    const done = turnDone;
    turnDone = null;
    if (done) done();
  }

  function finishInterrupt(killed) {
    if (interruptTimer) {
      clearTimeout(interruptTimer);
      interruptTimer = null;
    }
    if (interruptResolve) {
      const resolve = interruptResolve;
      interruptResolve = null;
      if (killed) onEvent('turn_finished', { stopped: true, killed: true, engine_session_id: threadId });
      resolve();
    }
  }

  async function handleServerRequest(obj) {
    const { id, method, params } = obj;
    if (method === 'mcpServer/elicitation/request') {
      if (params?.serverName === MCP_SERVER_NAME && params?._meta?.codex_approval_kind === 'mcp_tool_call') {
        respond(id, { action: 'accept', content: {}, _meta: null });
      } else {
        respond(id, { action: 'decline', content: null, _meta: null });
      }
      return;
    }
    if (method === 'item/fileChange/requestApproval') {
      const changes = fileChanges.get(params?.itemId);
      if (!changes || !reviewFileChange) {
        respond(id, { decision: 'decline' });
        return;
      }
      try {
        const { ok, reason } = await reviewFileChange(changes);
        // A decline alone reaches the model as "patch rejected by user"; steer the
        // policy reason in first so it can act on it (e.g. OR-first -> or_draft).
        if (!ok && reason && params.turnId) {
          await request('turn/steer', {
            threadId: params.threadId,
            expectedTurnId: params.turnId,
            input: [{ type: 'text', text: `Keelvane policy declined that apply_patch: ${reason}`, text_elements: [] }],
          }).catch(() => {});
        }
        respond(id, { decision: ok ? 'accept' : 'decline' });
      } catch {
        respond(id, { decision: 'decline' });
      }
      return;
    }
    if (method === 'item/commandExecution/requestApproval') {
      respond(id, { decision: 'decline' });
      return;
    }
    respondError(id, 'not supported by Keelvane');
  }

  function handleNotification(obj) {
    const { method, params } = obj;
    if (method === 'turn/started') {
      if (params?.threadId === threadId && params?.turn?.id) currentTurnId = params.turn.id;
      return;
    }
    if (method === 'item/started') {
      const item = params?.item;
      if (item?.type === 'fileChange' && item?.changes) {
        fileChanges.set(item.id, item.changes);
      }
      if (params?.threadId === threadId && item?.type === 'agentMessage') {
        if (agentMessageProducedText) onEvent('text_delta', { text: '\n\n' });
        agentMessageProducedText = true;
      }
      return;
    }
    if (method === 'item/agentMessage/delta') {
      if (params?.threadId === threadId && params?.delta) onEvent('text_delta', { text: params.delta });
      return;
    }
    if (method === 'item/completed') {
      const item = params?.item;
      if (item?.type === 'fileChange') fileChanges.delete(item.id);
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      if (params?.threadId === threadId && params?.tokenUsage?.last) {
        const last = params.tokenUsage.last;
        turnUsage.inputTokens += last.inputTokens || 0;
        turnUsage.cachedInputTokens += last.cachedInputTokens || 0;
        turnUsage.outputTokens += last.outputTokens || 0;
        turnUsage.reasoningOutputTokens += last.reasoningOutputTokens || 0;
      }
      return;
    }
    if (method === 'turn/completed') {
      if (params?.threadId !== threadId) return;
      const turn = params.turn || {};
      if (turn.status === 'completed') {
        onEvent('turn_finished', {
          engine_session_id: threadId,
          usage: {
            input_tokens: turnUsage.inputTokens,
            cache_read_input_tokens: turnUsage.cachedInputTokens,
            output_tokens: turnUsage.outputTokens,
            reasoning_output_tokens: turnUsage.reasoningOutputTokens,
          },
          stop_reason: 'end_turn',
          subtype: 'success',
        });
      } else if (turn.status === 'interrupted') {
        onEvent('turn_finished', { stopped: true, engine_session_id: threadId });
      } else if (turn.status === 'failed') {
        onEvent('error', {
          message: turn.error?.message || 'codex turn failed',
          engine_session_id: threadId,
        });
      }
      endTurn();
      finishInterrupt(false);
      return;
    }
    // Everything else (error notifications with willRetry,
    // account/rateLimits/updated, status updates) is noise for the harness.
  }

  function handleLine(line) {
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj.id !== undefined && obj.method !== undefined) {
      handleServerRequest(obj);
      return;
    }
    if (obj.id !== undefined) {
      const entry = pending.get(obj.id);
      if (!entry) return;
      pending.delete(obj.id);
      if (obj.error) entry.reject(new Error(obj.error.message || 'codex request failed'));
      else entry.resolve(obj.result);
      return;
    }
    if (obj.method !== undefined) {
      handleNotification(obj);
    }
  }

  const rl = createInterface({ input: child.stdout });
  rl.on('line', handleLine);

  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
  });

  child.on('error', (error) => {
    exited = true;
    readyReject(new Error(error.message));
    onEvent('error', { message: `codex could not start: ${error.message}` });
  });

  child.on('exit', (code) => {
    exited = true;
    for (const entry of pending.values()) entry.reject(new Error('codex process exited'));
    pending.clear();
    readyReject(new Error('codex process exited before startup completed'));
    const turnWasRunning = currentTurnId !== null;
    endTurn();
    finishInterrupt(false);
    if (!killedByUs && ((code !== 0 && code !== null) || turnWasRunning)) {
      const tail = stripAnsi(stderrTail).slice(-STDERR_ERROR_TAIL);
      onEvent('error', {
        message: `codex process exited with code ${code}${tail ? `: ${tail}` : ''}`,
      });
    }
  });

  async function startup() {
    await request('initialize', {
      clientInfo: { name: 'keelvane', title: 'Keelvane Harness', version: '0.3.0' },
      capabilities: null,
    });
    notify('initialized', {});
    const status = await request('mcpServerStatus/list', {});
    const servers = status?.data || [];
    for (const server of servers) {
      if (server.name !== MCP_SERVER_NAME && server.tools && Object.keys(server.tools).length > 0) {
        throw new Error(`ambient MCP server ${server.name} is still exposing tools; refusing to start`);
      }
    }
    const ownServer = servers.find((server) => server.name === MCP_SERVER_NAME);
    if (!ownServer || !ownServer.tools || Object.keys(ownServer.tools).length === 0) {
      throw new Error(`${MCP_SERVER_NAME} has zero tools`);
    }
    const developerInstructions = `${DEVELOPER_INSTRUCTIONS(projectRoot)}

${instructions}`;
    const startResult = resumeId
      ? await request('thread/resume', {
          threadId: resumeId,
          cwd: projectRoot,
          approvalPolicy: 'on-request',
          sandbox: 'read-only',
          model,
          developerInstructions,
        })
      : await request('thread/start', {
          cwd: projectRoot,
          approvalPolicy: 'on-request',
          sandbox: 'read-only',
          model,
          developerInstructions,
        });
    threadId = startResult.thread.id;
  }

  startup()
    .then(() => readyResolve())
    .catch((error) => {
      onEvent('error', { message: 'codex startup failed: ' + error.message });
      killedByUs = true;
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    });

  return {
    get exited() {
      return exited;
    },

    send(text, images = []) {
      if (exited) {
        onEvent('error', { message: 'engine process has already exited' });
        return;
      }
      if (!Array.isArray(images)) {
        onEvent('error', { message: 'Codex image attachments must be an array' });
        return;
      }
      if (images.length) {
        onEvent('error', { message: 'image attachments are not supported by the Codex engine' });
        return;
      }
      // One turn at a time, like the Claude CLI: a message sent mid-turn waits.
      turnQueue = turnQueue.then(async () => {
        let preparedImages = null;
        try {
          await ready;
          if (images.length) preparedImages = prepareScopedImageInputs(images, dataDir);
          const finished = new Promise((resolve) => { turnDone = resolve; });
          turnStarting = request('turn/start', { threadId, input: [
            { type: 'text', text, text_elements: [] },
            ...(preparedImages?.inputs || []),
          ] });
          const result = await turnStarting;
          if (turnDone) currentTurnId = result.turn.id; // unless it already completed
          await finished;
        } catch (error) {
          turnDone = null;
          if (!exited) onEvent('error', { message: `codex turn failed to start: ${error.message}` });
        } finally {
          preparedImages?.cleanup();
          turnStarting = null;
        }
      });
    },

    async interrupt() {
      // Stop right after send: wait for the turn id instead of missing the turn.
      if (!exited && currentTurnId === null && turnStarting) await turnStarting.catch(() => {});
      if (exited || currentTurnId === null) return;
      await new Promise((resolve) => {
        interruptResolve = resolve;
        interruptTimer = setTimeout(() => {
          interruptTimer = null;
          killedByUs = true;
          try { child.kill(); } catch { /* already gone */ }
          finishInterrupt(true);
        }, INTERRUPT_TIMEOUT_MS);
        // A request, not a notification: app-server answers {} and then sends
        // turn/completed with status interrupted, which resolves this.
        request('turn/interrupt', { threadId, turnId: currentTurnId }).catch(() => {});
      });
    },

    kill() {
      if (exited) return;
      killedByUs = true;
      try {
        child.stdin.end();
      } catch {
        // Ignore.
      }
      try {
        child.kill();
      } catch {
        // Ignore.
      }
    },
  };
}
