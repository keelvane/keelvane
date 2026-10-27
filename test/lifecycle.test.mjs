// Backup, update, rollback and uninstall on an in-memory machine. The key property: uninstall never touches
// a project folder, even when a project sits inside the install folder or the data folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { runWizard, readLaunch, writeLaunch } from '../setup/wizard.mjs';
import { backup, update, rollback, uninstall, findPayload } from '../setup/lifecycle.mjs';
import { realSystem, dryRunSystem, CRED_TARGET, TASK_NAME } from '../setup/system.mjs';
import { makeFakeSystem } from './fake-system.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); fs.statSync(f).isDirectory() ? (out[f] = 'dir', walk(f)) : (out[f] = fs.readFileSync(f, 'utf8')); } };
  walk(dir);
  return out;
}

async function installed({ projectsInside = false, dataInsideProject = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-life-'));
  const root = path.join(base, 'install');
  const home = projectsInside ? path.join(root, 'projects') : base;
  const alpha = path.join(home, 'alpha'); const bravo = path.join(home, 'bravo');
  for (const d of [alpha, bravo]) { fs.mkdirSync(path.join(d, 'src'), { recursive: true }); fs.writeFileSync(path.join(d, 'src', 'a.txt'), `data of ${path.basename(d)}`); fs.writeFileSync(path.join(d, 'keep.md'), 'keep'); }
  const sys = makeFakeSystem();
  const answers = { projects: [{ code: 'alpha', name: 'Alpha', path: alpha }, { code: 'bravo', name: 'Bravo', path: bravo }], tailscale: true, autostart: true, loopback: false };
  if (dataInsideProject) answers.dataDir = path.join(alpha, 'ledger');
  const launch = { node: process.execPath, appDir: PKG, version: '0.1.0' };
  await runWizard({ root, answers, sys, launch });
  return { base, root, alpha, bravo, sys, launch, config: JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('uninstall removes what Keelvane made and leaves project folders byte for byte alone', async () => {
  const m = await installed();
  try {
    m.sys.state.serve = true; m.sys.state.servePort = m.config.ports.connector;
    const before = { alpha: snapshot(m.alpha), bravo: snapshot(m.bravo) };
    const r = await uninstall({ root: m.root, sys: m.sys, removeData: true, removeServe: true });
    assert.deepEqual({ alpha: snapshot(m.alpha), bravo: snapshot(m.bravo) }, before);
    assert.equal(m.sys.tasks.size, 0);
    assert.equal(m.sys.creds.has(CRED_TARGET), false);
    assert.equal(m.sys.state.serve, false);
    assert.equal(fs.existsSync(m.root), false, 'an empty install folder is removed');
    assert.deepEqual(r.residue, []);
    assert.ok(r.kept.some((k) => k.includes(m.alpha)) && r.kept.some((k) => k.includes(m.bravo)));
    const allowed = ['cred.set', 'clipboard', 'task.create', 'startService', 'stopService', 'cred.del', 'task.remove', 'tailscale.unserve', 'openUrl'];
    assert.deepEqual(m.sys.calls.filter((c) => !allowed.includes(c.name)).map((c) => c.name), [], 'nothing touches the vendor CLIs');
  } finally { m.cleanup(); }
});

test('uninstall keeps data, config and the serve rule unless told otherwise', async () => {
  const m = await installed();
  try {
    m.sys.state.serve = true; m.sys.state.servePort = m.config.ports.connector;
    fs.writeFileSync(path.join(m.config.dataDir, 'keelvane.sqlite'), 'ledger');
    const r = await uninstall({ root: m.root, sys: m.sys });
    assert.ok(fs.existsSync(path.join(m.config.dataDir, 'keelvane.sqlite')));
    assert.ok(fs.existsSync(path.join(m.root, 'config.json')));
    assert.equal(m.sys.state.serve, true);
    assert.equal(fs.existsSync(path.join(m.root, 'app')), false);
    assert.ok(r.kept.some((k) => /tailscale serve rule/.test(k)));
    assert.equal(m.sys.calls.some((c) => c.name === 'tailscale.unserve'), false);
  } finally { m.cleanup(); }
});

test('a project inside the install folder survives a full uninstall', async () => {
  const m = await installed({ projectsInside: true });
  try {
    const before = snapshot(m.alpha);
    await uninstall({ root: m.root, sys: m.sys, removeData: true });
    assert.deepEqual(snapshot(m.alpha), before);
    assert.ok(fs.existsSync(m.root), 'the folder that contains projects is not removed');
    assert.equal(fs.existsSync(path.join(m.root, 'app')), false);
  } finally { m.cleanup(); }
});

test('a data folder inside a project is never deleted', async () => {
  const m = await installed({ dataInsideProject: true });
  try {
    fs.writeFileSync(path.join(m.config.dataDir, 'keelvane.sqlite'), 'ledger');
    const before = snapshot(m.alpha);
    const r = await uninstall({ root: m.root, sys: m.sys, removeData: true });
    assert.deepEqual(snapshot(m.alpha), before);
    assert.ok(r.kept.some((k) => k.includes('overlaps a project folder')));
  } finally { m.cleanup(); }
});

test('uninstall still works with a broken config and reports leftovers', async () => {
  const m = await installed();
  try {
    fs.writeFileSync(path.join(m.root, 'config.json'), '{not json');
    const r = await uninstall({ root: m.root, sys: m.sys });
    assert.equal(m.sys.tasks.size, 0);
    assert.equal(m.sys.creds.has(CRED_TARGET), false);
    assert.equal(fs.existsSync(path.join(m.root, 'app')), false);
    assert.deepEqual(r.residue, []);
  } finally { m.cleanup(); }
});

function makeLedger(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'keelvane.sqlite'));
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');");
  db.close();
}

test('backup holds the config and a consistent ledger copy', async () => {
  const m = await installed();
  try {
    makeLedger(m.config.dataDir);
    const dest = backup({ root: m.root, sys: m.sys, now: new Date('2026-10-25T10:00:00Z') });
    assert.match(path.basename(dest), /^keelvane-backup-2026-10-25T10-00-00-000Z\.zip$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(dest, 'utf8')).sort(), ['config.json', 'keelvane.sqlite']);
  } finally { m.cleanup(); }
});

test('backup produces a real zip', async () => {
  const m = await installed();
  try {
    makeLedger(m.config.dataDir);
    const dest = backup({ root: m.root, sys: realSystem() });
    assert.ok(fs.statSync(dest).size > 100);
    assert.equal(fs.readFileSync(dest).subarray(0, 2).toString(), 'PK');
  } finally { m.cleanup(); }
});

function fakeApp(base, version) {
  const dir = path.join(base, `app-src-${version}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'keelvane', version }));
  fs.writeFileSync(path.join(dir, 'server.mjs'), '// stub\n');
  return dir;
}

test('update keeps config and data, backs up the ledger, and rollback swaps back', async () => {
  const m = await installed();
  try {
    makeLedger(m.config.dataDir);
    const configBefore = fs.readFileSync(path.join(m.root, 'config.json'), 'utf8');
    const v1 = fakeApp(m.base, '1.0.0'); const v2 = fakeApp(m.base, '2.0.0'); const v3 = fakeApp(m.base, '3.0.0');
    writeLaunch(m.root, { node: process.execPath, appDir: path.join(m.root, 'app', '0.1.0'), version: '0.1.0' });
    fs.mkdirSync(path.join(m.root, 'app', '0.1.0'), { recursive: true });
    m.sys.state.listening.add(m.config.ports.ui);

    const a = await update({ root: m.root, sys: m.sys, newAppDir: v1 });
    assert.equal(a.changed, true);
    assert.equal(readLaunch(m.root).version, '1.0.0');
    assert.ok(a.backupFile && fs.existsSync(a.backupFile), 'pre-migration ledger copy exists');
    const bdb = new DatabaseSync(a.backupFile); assert.equal(bdb.prepare('SELECT v FROM t').get().v, 'kept'); bdb.close();
    assert.equal(fs.readFileSync(path.join(m.root, 'config.json'), 'utf8'), configBefore);
    assert.ok(m.sys.calls.some((c) => c.name === 'stopService') && m.sys.calls.some((c) => c.name === 'startService'));

    assert.equal((await update({ root: m.root, sys: m.sys, newAppDir: v1 })).changed, false, 'same version is a no-op');
    await update({ root: m.root, sys: m.sys, newAppDir: v2 });
    assert.ok(fs.existsSync(path.join(m.root, 'app', '1.0.0')), 'previous version kept for rollback');
    assert.equal(fs.existsSync(path.join(m.root, 'app', '0.1.0')), false, 'older versions are pruned');

    assert.equal((await rollback({ root: m.root, sys: m.sys })).version, '1.0.0');
    assert.equal(readLaunch(m.root).version, '1.0.0');
    await update({ root: m.root, sys: m.sys, newAppDir: v3 });
    assert.deepEqual(fs.readdirSync(path.join(m.root, 'app')).filter((n) => n !== 'current.json').sort(), ['1.0.0', '3.0.0']);
  } finally { m.cleanup(); }
});

test('rollback with no previous version says so, and update rejects a non-app folder', async () => {
  const m = await installed();
  try {
    await assert.rejects(rollback({ root: m.root, sys: m.sys }), /no previous version/);
    const junk = path.join(m.base, 'junk'); fs.mkdirSync(junk); fs.writeFileSync(path.join(junk, 'package.json'), '{"version":"9.9.9"}');
    await assert.rejects(update({ root: m.root, sys: m.sys, newAppDir: junk }), /does not look like a Keelvane app/);
  } finally { m.cleanup(); }
});

test('findPayload recognises the release layout only', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-pay-'));
  try {
    fs.mkdirSync(path.join(base, 'app'), { recursive: true }); fs.mkdirSync(path.join(base, 'node'));
    assert.equal(findPayload(path.join(base, 'app', 'keelvane.mjs')), null);
    fs.writeFileSync(path.join(base, 'node', 'node.exe'), 'x'); fs.writeFileSync(path.join(base, 'payload.json'), '{"version":"1.2.3"}');
    assert.equal(findPayload(path.join(base, 'app', 'keelvane.mjs')).version, '1.2.3');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('uninstall and update dry runs delete and change nothing', async () => {
  const m = await installed();
  try {
    fs.writeFileSync(path.join(m.config.dataDir, 'keelvane.sqlite'), 'ledger');
    const before = snapshot(m.root);
    const dry = dryRunSystem(m.sys, () => {});
    const r = await uninstall({ root: m.root, sys: dry, removeData: true, removeServe: true });
    assert.deepEqual(snapshot(m.root), before);
    assert.ok(r.removed.some((x) => x.includes('[dry-run]')));
    assert.equal(m.sys.tasks.size, 1);
    const v = fakeApp(m.base, '5.0.0');
    assert.equal((await update({ root: m.root, sys: dry, newAppDir: v })).dryRun, true);
    assert.deepEqual(snapshot(m.root), before);
  } finally { m.cleanup(); }
});

test('uninstall refuses a folder that is not a Keelvane install', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-notmine-'));
  try {
    fs.mkdirSync(path.join(base, 'app')); fs.writeFileSync(path.join(base, 'app', 'mine.txt'), 'x');
    await assert.rejects(uninstall({ root: base, sys: makeFakeSystem() }), /refusing/);
    assert.ok(fs.existsSync(path.join(base, 'app', 'mine.txt')));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('an unsafe version string cannot turn into a delete outside the app folder', async () => {
  const m = await installed();
  try {
    for (const version of ['..', '../..', '1.0.0/../..']) {
      const dir = path.join(m.base, `evil-${version.replace(/\W/g, '_')}`); fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version })); fs.writeFileSync(path.join(dir, 'server.mjs'), '');
      await assert.rejects(update({ root: m.root, sys: m.sys, newAppDir: dir }), /unsafe/);
    }
    assert.ok(fs.existsSync(path.join(m.root, 'config.json')));
  } finally { m.cleanup(); }
});

test('a data folder outside the install loses only Keelvane files', async () => {
  const m = await installed();
  try {
    const shared = path.join(m.base, 'shared-docs'); fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'keelvane.sqlite'), 'l'); fs.writeFileSync(path.join(shared, 'mine.docx'), 'keep');
    const f = path.join(m.root, 'config.json'); const c = JSON.parse(fs.readFileSync(f, 'utf8')); c.dataDir = shared; fs.writeFileSync(f, JSON.stringify(c));
    await uninstall({ root: m.root, sys: m.sys, removeData: true });
    assert.equal(fs.existsSync(path.join(shared, 'keelvane.sqlite')), false);
    assert.equal(fs.readFileSync(path.join(shared, 'mine.docx'), 'utf8'), 'keep');
  } finally { m.cleanup(); }
});

test('the task name and credential target are fenced to Keelvane', async () => {
  assert.equal(TASK_NAME.startsWith('Keelvane'), true);
  assert.equal(CRED_TARGET.startsWith('Keelvane'), true);
  const sys = realSystem();
  await assert.rejects(sys.cred.get('SomeoneElse/entry'));
  await assert.rejects(sys.task.has('SomeoneElseTask'));
});
