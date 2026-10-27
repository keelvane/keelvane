// Real Windows Credential Manager round trip, on a clearly named throwaway target that is deleted in finally.
// Never uses the production target, and the script itself refuses any name that does not start with Keelvane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realSystem } from '../setup/system.mjs';

const skip = process.platform !== 'win32' ? 'Windows only' : false;

test('set, has, get and delete on a throwaway target', { skip }, async () => {
  const sys = realSystem();
  const target = `Keelvane-test-throwaway-${process.pid}`;
  try {
    assert.equal(await sys.cred.has(target), false);
    await sys.cred.set(target, 'throwaway-secret-value');
    assert.equal(await sys.cred.has(target), true);
    assert.equal(await sys.cred.get(target), 'throwaway-secret-value');
  } finally {
    await sys.cred.del(target);
  }
  assert.equal(await sys.cred.has(target), false);
});

test('a target without the Keelvane prefix is refused', { skip }, async () => {
  const sys = realSystem();
  await assert.rejects(sys.cred.get('NotKeelvane-entry'));
  await assert.rejects(sys.cred.set('NotKeelvane-entry', 'x'));
  await assert.rejects(sys.cred.del('NotKeelvane-entry'));
});
