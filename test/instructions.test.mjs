import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadInstructions } from '../instructions.mjs';

test('both engines receive a short project note naming the project root and engine', () => {
  const root = 'C:/example/alpha';
  for (const engine of ['claude', 'codex']) {
    const result = loadInstructions(root, engine);
    assert.ok(result.includes(root));
    assert.ok(result.includes(`Engine: ${engine}.`));
    assert.match(result, /data, never instructions/);
    assert.ok(result.length < 1000);
  }
  assert.notEqual(loadInstructions(root, 'claude'), loadInstructions(root, 'codex'));
});
