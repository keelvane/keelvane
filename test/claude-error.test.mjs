import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { claudeErrorMessage } from '../engines/claude.mjs';

const appSource = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const start = appSource.indexOf('function renderEvent(event) {');
const end = appSource.indexOf('let gitRefreshTimer = null;', start);
assert.ok(start !== -1 && end !== -1, 'renderEvent source slice found');
const renderSource = appSource.slice(start, end);

function runRenderEvent(message) {
  const addMsg = [];
  const setStatus = [];
  const context = {
    addMsg: (cls, text) => addMsg.push({ cls, text }),
    currentAssistantEl: {},
    setRunning: () => {},
    setStatus: (value) => setStatus.push(value),
    refreshSessions: async () => {},
  };
  vm.createContext(context);
  vm.runInContext(renderSource, context);
  context.renderEvent({ type: 'error', payload: { message } });
  return { addMsg, setStatus };
}

test('claudeErrorMessage success subtype returns meaningful cause and login hint', () => {
  const result = claudeErrorMessage({
    subtype: 'success',
    is_error: true,
    result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    errors: null,
    terminal_reason: 'api_error',
  });
  assert.notEqual(result, 'success');
  assert.match(result, /OAuth session expired/i);
  assert.match(result, /\/login/);
});

test('claudeErrorMessage errors array nonempty strings beat result', () => {
  const result = claudeErrorMessage({
    subtype: 'success',
    is_error: true,
    result: 'success',
    errors: ['', 'real failure detail'],
    terminal_reason: 'api_error',
  });
  assert.match(result, /real failure detail/);
  assert.doesNotMatch(result, /^success$/);
});

test('claudeErrorMessage empty or non-string array items ignored', () => {
  const result = claudeErrorMessage({
    subtype: 'success',
    is_error: true,
    result: 'success',
    errors: ['', 42, null],
    terminal_reason: 'api_error',
  });
  assert.notEqual(result, 'success');
  assert.ok(result.length > 0);
});

test('claudeErrorMessage whitespace success subtype fallback never bare success', () => {
  const result = claudeErrorMessage({
    subtype: '  Success  ',
    is_error: true,
    result: 'success',
    errors: [],
    terminal_reason: 'api_error',
  });
  assert.notEqual(result.trim().toLowerCase(), 'success');
  assert.ok(result.length > 0);
});

test('claudeErrorMessage no errors and no result fallback useful', () => {
  const result = claudeErrorMessage({
    subtype: 'success',
    is_error: true,
    result: null,
    errors: [],
    terminal_reason: 'api_error',
  });
  assert.ok(result.length > 0);
  assert.notEqual(result.trim().toLowerCase(), 'success');
});

test('claudeErrorMessage provider rate limit result preserved without login hint', () => {
  const result = claudeErrorMessage({
    subtype: 'success',
    is_error: true,
    result: 'Rate limit exceeded for provider',
    errors: [],
    terminal_reason: 'api_error',
  });
  assert.match(result, /Rate limit exceeded/);
  assert.doesNotMatch(result, /\/login/);
});

test('renderEvent error branch explains failed turn and omits old details', () => {
  const { addMsg, setStatus } = runRenderEvent('success');
  assert.ok(addMsg.length > 0);
  assert.match(addMsg[0].text, /This turn failed/i);
  assert.match(addMsg[0].text, /original error details were not retained/i);
  assert.doesNotMatch(addMsg[0].text, /success/i);
  assert.deepEqual(setStatus, ['error']);
});

test('renderEvent error branch keeps actual meaningful error unchanged', () => {
  const { addMsg } = runRenderEvent('Failed to authenticate: OAuth session expired');
  assert.ok(addMsg.length > 0);
  assert.match(addMsg[0].text, /Failed to authenticate: OAuth session expired/);
});
