import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectNativeRoute, normalizeUsage, usageCapacity, buildNativePool, UNKNOWN_COST_PRIOR } from '../routing.mjs';

const now = Date.parse('2026-01-01T12:00:00Z');
const reset = new Date(now + 3600000).toISOString();
const past = new Date(now - 60000).toISOString();
const rec = (remaining, extra = {}) => ({ observedAt: new Date(now).toISOString(), available: true, windows: [{ remainingPercent: remaining, resetsAt: reset, windowMinutes: 300 }], ...extra });
const entry = (routeId, extra = {}) => ({ family: 'fam', model: `m-${routeId}`, routeId, roles: ['manager'], capabilities: ['text'], ...extra });
const pick = (pool, routes, opts = {}) => selectNativeRoute({ text: 'plain' }, { pool, usage: { routes }, now, ...opts });

test('more remaining usage means lower cost and wins', async () => {
  const r = await pick([entry('route-a'), entry('route-b'), entry('route-c')], { 'route-a': rec(30), 'route-b': rec(80), 'route-c': rec(50) });
  assert.equal(r.routeId, 'route-b');
  assert.ok(Math.abs(r.routeCost - 0.2) < 1e-9);
});

test('below 15 percent remaining takes a steep penalty', async () => {
  const r = await pick([entry('route-a'), entry('route-b')], { 'route-a': rec(14), 'route-b': rec(16) });
  assert.equal(r.routeId, 'route-b');
  assert.ok(Math.abs(r.routeCost - 0.84) < 1e-9);
  const low = await pick([entry('route-a')], { 'route-a': rec(14) });
  assert.ok(Math.abs(low.routeCost - 1.46) < 1e-9);
  const tuned = await pick([entry('route-a')], { 'route-a': rec(14) }, { lowThreshold: 0.1 });
  assert.ok(Math.abs(tuned.routeCost - 0.86) < 1e-9);
});

test('exhausted routes are excluded', async () => {
  const r = await pick([entry('route-a'), entry('route-b')], { 'route-a': rec(0), 'route-b': rec(5) });
  assert.equal(r.routeId, 'route-b');
  const none = await pick([entry('route-a')], { 'route-a': rec(0) });
  assert.equal(none.routeId, null);
  assert.equal(none.reason, 'capacity_or_capability_blocked');
  assert.equal(usageCapacity(rec(50, { ordinaryUsageAllowed: false }), now), 'exhausted');
});

test('tightest of several windows counts', () => {
  const p = rec(90);
  p.windows.push({ remainingPercent: 12, resetsAt: reset, windowMinutes: 10080 });
  const u = normalizeUsage(p, now);
  assert.equal(u.remainingPercent, 12);
  assert.equal(u.state, 'low');
  const legacy = { observedAt: p.observedAt, available: true, rolling: { remainingPercent: 70, resetsAt: reset }, week: { remainingPercent: 20, resetsAt: reset } };
  assert.equal(normalizeUsage(legacy, now).remainingPercent, 20);
});

test('observations older than 15 minutes become unknown', async () => {
  const old = rec(90, { observedAt: new Date(now - 16 * 60000).toISOString() });
  assert.equal(usageCapacity(old, now), 'unknown');
  assert.equal(usageCapacity(rec(90, { observedAt: new Date(now - 14 * 60000).toISOString() }), now), 'available');
  assert.equal(usageCapacity(rec(50, { ordinaryUsageAllowed: false, observedAt: old.observedAt }), now), 'unknown');
  const r = await pick([entry('route-a')], { 'route-a': old });
  assert.equal(r.usage.state, 'unknown');
});

test('a zero window whose reset already passed is not exhausted', () => {
  const p = rec(0);
  p.windows[0].resetsAt = past;
  assert.equal(usageCapacity(p, now), 'unknown');
});

test('unknown beats a low-quota known route but loses to a high-quota one', async () => {
  const pool = [entry('route-a'), entry('route-u')];
  assert.equal((await pick(pool, { 'route-a': rec(10) })).routeId, 'route-u');
  assert.equal((await pick(pool, { 'route-a': rec(80) })).routeId, 'route-a');
  assert.equal(UNKNOWN_COST_PRIOR, 0.5);
});

test('unknown route reports null usage fields, never a fake 50 percent', async () => {
  const r = await pick([entry('route-u')], {});
  assert.equal(r.usage.state, 'unknown');
  assert.equal(r.usage.remainingPercent, null);
  assert.equal(r.routeCost, null);
  assert.equal(r.score, null);
  assert.equal(normalizeUsage(undefined, now).score, null);
});

test('usage score weights headroom, recovery and freshness', () => {
  const u = normalizeUsage(rec(60), now);
  assert.equal(u.state, 'available');
  assert.ok(Math.abs(u.score - (0.75 * 0.6 + 0.2 * u.components.recovery + 0.05)) < 1e-9);
  assert.equal(usageCapacity(rec(10), now), 'low');
  assert.equal(usageCapacity(rec(50, { stale: true }), now), 'unknown');
});

test('decide is honored when it names an eligible route', async () => {
  const pool = [entry('route-a'), entry('route-b')];
  const usage = { 'route-a': rec(90), 'route-b': rec(20) };
  const r = await pick(pool, usage, { decide: async (req) => { assert.equal(req.candidates.length, 2); return { routeId: 'route-b' }; } });
  assert.equal(r.routeId, 'route-b');
  assert.equal(r.source, 'decide');
});

test('decide is ignored when ineligible, failing, or the task is private', async () => {
  const pool = [entry('route-a'), entry('route-x')];
  const usage = { 'route-a': rec(90), 'route-x': rec(0) };
  assert.equal((await pick(pool, usage, { decide: async () => ({ routeId: 'route-x' }) })).routeId, 'route-a');
  assert.equal((await pick(pool, usage, { decide: async () => ({ routeId: 'nope' }) })).source, 'policy_fallback');
  assert.equal((await pick(pool, usage, { decide: async () => { throw new Error('down'); } })).routeId, 'route-a');
  let called = false;
  const p = await pick([entry('route-a'), entry('route-b')], { 'route-b': rec(99) }, { isPrivate: true, decide: async () => { called = true; return { routeId: 'route-a' }; } });
  assert.equal(p.routeId, 'route-b');
  assert.equal(called, false);
});

test('capability, role and family filters apply', async () => {
  const pool = [entry('route-a'), entry('route-b', { capabilities: ['text', 'images'] }), entry('route-w', { roles: ['worker'] }), entry('route-f', { family: 'other' })];
  const usage = { 'route-a': rec(90), 'route-b': rec(10), 'route-w': rec(99), 'route-f': rec(99) };
  assert.equal((await pick(pool, usage, { requiredCapabilities: ['images'] })).routeId, 'route-b');
  assert.equal((await pick(pool, usage, { role: 'worker' })).routeId, 'route-w');
  assert.equal((await pick(pool, usage, { allowedFamilies: ['fam'] })).routeId, 'route-a');
  assert.equal((await pick(pool, usage, { requiredCapabilities: ['audio'] })).routeId, null);
});

test('ties break deterministically by route id regardless of pool order', async () => {
  const usage = { 'route-a': rec(50), 'route-b': rec(50) };
  assert.equal((await pick([entry('route-b'), entry('route-a')], usage)).routeId, 'route-a');
  assert.equal((await pick([entry('route-a'), entry('route-b')], usage)).routeId, 'route-a');
});

test('buildNativePool merges duplicates and drops unavailable entries', () => {
  const pool = buildNativePool({
    catalog: [{ family: 'fam', model: 'm1', routeId: 'route-a', available: true }, { family: 'fam', model: 'm2', available: false }],
    workers: { fam: [{ model: 'm1', routeId: 'route-a' }, { model: 'm3', routeId: 'route-c', capabilities: ['images'] }] },
  });
  assert.deepEqual(pool.map((c) => c.model), ['m1', 'm3']);
  assert.deepEqual(pool[0].roles, ['manager', 'worker']);
  assert.equal(pool[0].availability, 'verified');
  assert.deepEqual(pool[1].roles, ['worker']);
  assert.equal(buildNativePool({ catalog: [{ family: 'x', model: 'm' }], allowedFamilies: ['fam'] }).length, 0);
});
