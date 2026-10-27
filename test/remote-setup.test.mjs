import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { policyFragments, newToken } from '../remote-setup.mjs';

const ts = { tailnetIp: '10.0.0.9', peers: [] };
const CAP = 'example.test/cap/keelvane-muse';

test('setup policy is additive fragments with tests, not a replacement', () => {
  const p = policyFragments(ts, CAP);
  assert.ok(p.tests.length >= 1 && p.hosts && p.grants && p.tagOwners['tag:muse']);
  const muse = p.grants.find((g) => g.src[0] === 'tag:muse');
  assert.deepEqual(muse.ip, ['tcp:8443']);
  assert.deepEqual(muse.app, { [CAP]: [{}] });
  assert.deepEqual(muse.dst, ['keelvane-host']);
  assert.equal(p.hosts['keelvane-host'], ts.tailnetIp);
  const museTest = p.tests.find((t) => t.src === 'tag:muse');
  assert.deepEqual(museTest.accept, ['10.0.0.9:8443']);
  assert.ok(museTest.deny.includes('10.0.0.9:443'));
  assert.ok(museTest.deny.includes('10.0.0.9:3389'));
  assert.ok(!JSON.stringify(p).includes('"*"'));
});

test('muse deny tests cover other nodes on the tailnet', () => {
  const p = policyFragments({ ...ts, peers: [{ ip: '10.0.0.20' }] }, CAP);
  const museTest = p.tests.find((t) => t.src === 'tag:muse');
  assert.ok(museTest.deny.includes('10.0.0.20:3389') && museTest.deny.includes('10.0.0.20:443'));
  assert.ok(museTest.accept.every((a) => a.endsWith(':8443')));
});

test('newToken returns a url-safe token and the matching SHA-256 hash, different each time', () => {
  const a = newToken();
  const b = newToken();
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.hash, createHash('sha256').update(a.token).digest('hex'));
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(a.token, b.token);
});
