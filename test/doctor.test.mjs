// Doctor against an in-memory machine; the loopback check spawns the real server on spare ports with the fake engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWizard } from '../setup/wizard.mjs';
import { runDoctor, formatDoctor } from '../setup/doctor.mjs';
import { CRED_TARGET } from '../setup/system.mjs';
import { makeFakeSystem } from './fake-system.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function healthy(over) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-doc-'));
  const root = path.join(base, 'install'); const alpha = path.join(base, 'alpha');
  fs.mkdirSync(alpha);
  const sys = makeFakeSystem(over);
  await runWizard({ root, answers: { projects: [{ code: 'alpha', name: 'Alpha', path: alpha }], tailscale: true, autostart: true, loopback: false }, sys, launch: { node: process.execPath, appDir: PKG, version: '0.1.0' } });
  return { base, root, sys, alpha, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const status = (r, name) => r.checks.find((c) => c.name === name)?.status;

test('no config is red and says to run setup', async () => {
  const r = await runDoctor({ root: path.join(os.tmpdir(), 'kv-nothing-here'), sys: makeFakeSystem(), loopback: false });
  assert.equal(r.overall, 'red');
  assert.match(formatDoctor(r), /run setup/);
});

test('an invalid config names the failing field', async () => {
  const m = await healthy();
  try {
    const f = path.join(m.root, 'config.json');
    const c = JSON.parse(fs.readFileSync(f, 'utf8')); c.projects[0].path = 'relative';
    fs.writeFileSync(f, JSON.stringify(c));
    const r = await runDoctor({ root: m.root, sys: m.sys, loopback: false });
    assert.equal(r.overall, 'red');
    assert.ok(r.checks.some((c) => c.name === 'config' && /path/.test(c.detail)));
  } finally { m.cleanup(); }
});

test('a healthy install passes the real loopback ask, read and exact retry', async () => {
  const m = await healthy();
  try {
    const r = await runDoctor({ root: m.root, sys: m.sys, appDir: PKG });
    assert.equal(status(r, 'loopback'), 'ok', JSON.stringify(r.checks.find((c) => c.name === 'loopback')));
    assert.equal(status(r, 'token'), 'ok');
    assert.equal(status(r, 'autostart'), 'ok');
    assert.notEqual(r.overall, 'red');
  } finally { m.cleanup(); }
});

test('a token that does not match the config hash fails', async () => {
  const m = await healthy();
  try {
    m.sys.creds.set(CRED_TARGET, 'some-other-token');
    const r = await runDoctor({ root: m.root, sys: m.sys, loopback: false });
    assert.equal(status(r, 'token'), 'fail');
    assert.equal(r.overall, 'red');
  } finally { m.cleanup(); }
});

test('a missing engine that a project uses fails; an unused one only warns', async () => {
  const m = await healthy();
  try {
    const sys = makeFakeSystem({ noEngines: true });
    sys.creds.set(CRED_TARGET, m.sys.creds.get(CRED_TARGET));
    const r = await runDoctor({ root: m.root, sys, loopback: false });
    assert.equal(status(r, 'engine claude'), 'fail');
    assert.equal(status(r, 'engine codex'), 'warn');
  } finally { m.cleanup(); }
});
