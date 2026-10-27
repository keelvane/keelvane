import path from 'node:path';
import readline from 'node:readline';

const FAKE_PATH = path.win32.join('C:\\', 'proj', 'a.md');

let nextId = 1;
let turnCount = 0;
let startedThread = null; // 'start' or 'resume:<id>'
let firstTurnDone = false;
let currentTurnId = null;
let pendingInterrupt = null; // { resolve } for slow turns
let hangMode = false;
let lastSteer = null;

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendNotification(method, params) {
  send({ method, params });
}

function sendServerRequest(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return id;
}

function sendResponse(id, result) {
  send({ id, result });
}

function sendError(id, message) {
  send({ id, error: { code: -32601, message } });
}

function playHello(threadId) {
  sendNotification('turn/started', { threadId, turn: { id: currentTurnId } });
  sendNotification('item/started', { threadId, item: { type: 'agentMessage', id: 'msg-1', status: 'inProgress' } });
  if (!firstTurnDone) {
    const prefix = startedThread === 'start' ? '[start] ' : `[resume ${startedThread.slice(7)}] `;
    sendNotification('item/agentMessage/delta', { threadId, itemId: 'msg-1', delta: prefix });
    firstTurnDone = true;
  }
  sendNotification('item/agentMessage/delta', { threadId, itemId: 'msg-1', delta: 'hi there' });
  sendNotification('item/completed', { threadId, item: { type: 'agentMessage', id: 'msg-1', status: 'completed' } });
  sendNotification('thread/tokenUsage/updated', {
    threadId,
    turnId: currentTurnId,
    tokenUsage: {
      total: 15,
      last: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 15, cacheWriteInputTokens: 0 },
      modelContextWindow: 200000,
    },
  });
  sendNotification('turn/completed', { threadId, turn: { id: currentTurnId, status: 'completed' } });
}

function playPatch(threadId) {
  sendNotification('turn/started', { threadId, turn: { id: currentTurnId } });
  sendNotification('item/started', {
    threadId,
    item: {
      type: 'fileChange',
      id: 'fc-1',
      status: 'inProgress',
      changes: [{ path: FAKE_PATH, kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }],
    },
  });
  const reqId = sendServerRequest('item/fileChange/requestApproval', {
    threadId,
    turnId: currentTurnId,
    itemId: 'fc-1',
    startedAtMs: Date.now(),
  });
  pendingApproval = { reqId, threadId, kind: 'patch' };
}

function playElicit(threadId) {
  sendNotification('turn/started', { threadId, turn: { id: currentTurnId } });
  const req1 = sendServerRequest('mcpServer/elicitation/request', {
    threadId,
    serverName: 'keelvane',
    mode: 'form',
    _meta: { codex_approval_kind: 'mcp_tool_call' },
  });
  const req2 = sendServerRequest('mcpServer/elicitation/request', {
    threadId,
    serverName: 'other',
    mode: 'form',
    _meta: { codex_approval_kind: 'mcp_tool_call' },
  });
  pendingElicit = { req1, req2, threadId, actions: [] };
}

function playCommand(threadId) {
  sendNotification('turn/started', { threadId, turn: { id: currentTurnId } });
  const reqId = sendServerRequest('item/commandExecution/requestApproval', {
    threadId,
    turnId: currentTurnId,
    itemId: 'cmd-1',
  });
  pendingCommand = { reqId, threadId };
}

function playSlow(threadId) {
  sendNotification('turn/started', { threadId, turn: { id: currentTurnId } });
  sendNotification('item/started', { threadId, item: { type: 'agentMessage', id: 'msg-slow', status: 'inProgress' } });
  sendNotification('item/agentMessage/delta', { threadId, itemId: 'msg-slow', delta: 'working' });
  pendingInterrupt = { threadId };
}

function playHang(threadId) {
  hangMode = true;
  playSlow(threadId);
}

function playFail(threadId) {
  sendNotification('turn/started', { threadId, turn: { id: currentTurnId } });
  sendNotification('turn/completed', { threadId, turn: { id: currentTurnId, status: 'failed', error: { message: 'boom' } } });
}

let pendingApproval = null;
let pendingElicit = null;
let pendingCommand = null;

function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      sendResponse(id, { userAgent: 'fake' });
      break;
    case 'mcpServerStatus/list':
      if (process.env.FAKE_CODEX_LEAK === '1') {
        sendResponse(id, {
          data: [
            { name: 'keelvane', tools: { read_file: {} } },
            { name: 'node_repl', tools: { exec: {} } },
          ],
        });
      } else {
        sendResponse(id, {
          data: [
            { name: 'keelvane', tools: { read_file: {} } },
            { name: 'node_repl', tools: {} },
          ],
        });
      }
      break;
    case 'thread/start':
      startedThread = 'start';
      sendResponse(id, { thread: { id: 'thr-new' }, model: 'fake' });
      break;
    case 'thread/resume':
      startedThread = `resume:${params.threadId}`;
      sendResponse(id, { thread: { id: params.threadId }, model: 'fake' });
      break;
    case 'turn/start': {
      turnCount += 1;
      currentTurnId = `turn-${turnCount}`;
      sendResponse(id, { turn: { id: currentTurnId, status: 'inProgress' } });
      const text = params.input?.[0]?.text ?? '';
      const threadId = params.threadId;
      if (text === 'hello') playHello(threadId);
      else if (text === 'patch') playPatch(threadId);
      else if (text === 'elicit') playElicit(threadId);
      else if (text === 'command') playCommand(threadId);
      else if (text === 'slow') playSlow(threadId);
      else if (text === 'hang') playHang(threadId);
      else if (text === 'fail') playFail(threadId);
      else sendNotification('turn/completed', { threadId, turn: { id: currentTurnId, status: 'completed' } });
      break;
    }
    case 'turn/steer':
      lastSteer = params.input?.[0]?.text ?? '';
      sendResponse(id, { turnId: params.expectedTurnId });
      break;
    case 'turn/interrupt': {
      if (hangMode) break; // ignore entirely
      if (pendingInterrupt) {
        sendResponse(id, {});
        const { threadId } = pendingInterrupt;
        pendingInterrupt = null;
        sendNotification('turn/completed', { threadId, turn: { id: currentTurnId, status: 'interrupted' } });
      } else {
        sendResponse(id, {});
      }
      break;
    }
    default:
      sendError(id, 'not supported by fake');
  }
}

function handleResponse(msg) {
  const { id, result, error } = msg;
  if (pendingApproval && pendingApproval.reqId === id) {
    const decision = error ? 'decline' : result?.decision ?? 'decline';
    const { threadId } = pendingApproval;
    pendingApproval = null;
    sendNotification('item/agentMessage/delta', { threadId, itemId: 'msg-patch', delta: `decision=${decision}${lastSteer ? ` steer=${lastSteer}` : ''}` });
    sendNotification('turn/completed', { threadId, turn: { id: currentTurnId, status: 'completed' } });
  } else if (pendingElicit && (pendingElicit.req1 === id || pendingElicit.req2 === id)) {
    const action = error ? 'decline' : result?.action ?? 'decline';
    pendingElicit.actions.push(action);
    if (pendingElicit.actions.length === 2) {
      const { threadId, actions } = pendingElicit;
      pendingElicit = null;
      sendNotification('item/agentMessage/delta', { threadId, itemId: 'msg-elicit', delta: `a1=${actions[0]} a2=${actions[1]}` });
      sendNotification('turn/completed', { threadId, turn: { id: currentTurnId, status: 'completed' } });
    }
  } else if (pendingCommand && pendingCommand.reqId === id) {
    const decision = error ? 'decline' : result?.decision ?? 'decline';
    const { threadId } = pendingCommand;
    pendingCommand = null;
    sendNotification('item/agentMessage/delta', { threadId, itemId: 'msg-cmd', delta: `cmd=${decision}` });
    sendNotification('turn/completed', { threadId, turn: { id: currentTurnId, status: 'completed' } });
  }
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore non-JSON lines
  }
  if (msg.method && msg.id !== undefined) {
    handleRequest(msg);
  } else if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    handleResponse(msg);
  }
  // notifications (method, no id) are accepted silently
});

rl.on('close', () => {
  process.exit(0);
});
