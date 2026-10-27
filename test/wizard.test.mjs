// Setup wizard against an in-memory machine: idempotent reruns, repair, dry-run, and no provider logins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runWizard } from '../setup/wizard.mjs';
import { dryRunSystem, CRED_TARGET, TASK_NAME } from '../setup/system.mjs';
import { makeFakeSystem } from './fake-system.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (t) => createHash('sha256').update(t).digest('hex');

function machine() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-wiz-'));
  const root = path.join(base, 'install');
  const alpha = path.join(base, 'alpha'); const bravo = path.join(base, 'bravo');
  for (const d of [alpha, bravo]) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'notes.md'), `# ${path.basename(d)}\n`); }
  const answers = {
    projects: [{ code: 'alpha', name: 'Alpha', path: alpha }, { code: 'bravo', name: 'Bravo', path: bravo }],
    tailscale: true, autostart: true, loopback: false,
  };
  const launch = { node: 'C:/fake/node.exe', appDir: PKG, version: '0.1.0' };
  return { base, root, alpha, bravo, answers, launch, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const readConfig = (root) => JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

test('first run writes a valid config, stores the token once and hands it over only by clipboard', async () => {
  const m = machine(); const sys = makeFakeSystem(); const lines = [];
  try {
    const report = await runWizard({ root: m.root, answers: m.answers, sys, launch: m.launch, log: (l) => lines.push(l) });
    const config = readConfig(m.root);
    assert.deepEqual(config.projects.map((p) => p.code), ['alpha', 'bravo']);
    assert.equal(config.connector.tokenSha256, sha(sys.creds.get(CRED_TARGET)));
    assert.equal(sys.state.clipboard, sys.creds.get(CRED_TARGET));
    const token = sys.creds.get(CRED_TARGET);
    assert.ok(!JSON.stringify(report).includes(token) && !lines.join('\n').includes(token) && !fs.readFileSync(path.join(m.root, 'config.json'), 'utf8').includes(token), 'the token is never printed or written');
    assert.equal(config.connector.serveHost, 'keelvane-test.tail0000.ts.net');
    assert.match(config.connector.capability, /^tail0000\.ts\.net\/cap\/keelvane-muse$/);
    const prompt = fs.readFileSync(path.join(m.root, 'muse-setup-prompt.md'), 'utf8');
    assert.ok(prompt.includes('Alpha') && prompt.includes('Bravo') && prompt.includes('https://keelvane-test.tail0000.ts.net:8443'));
    assert.ok(fs.existsSync(path.join(m.root, 'tailscale-policy-fragments.json')));
    assert.ok(sys.tasks.has(TASK_NAME));
    assert.equal(sys.calls.filter((c) => c.name === 'startService').length, 1);
    assert.equal(sys.calls.filter((c) => c.name === 'tailscale.serve').length, 0, 'tailscale serve runs only on an explicit yes');
    assert.ok(report.manual.some((t) => /tailscale serve --bg --https=8443/.test(t)));
    assert.ok(['green', 'yellow'].includes(report.doctor.overall));
  } finally { m.cleanup(); }
});

test('rerunning is idempotent: same config, one task, no new token, no second service start', async () => {
  const m = machine(); const sys = makeFakeSystem();
  try {
    await runWizard({ root: m.root, answers: m.answers, sys, launch: m.launch });
    const first = fs.readFileSync(path.join(m.root, 'config.json'), 'utf8');
    const token = sys.creds.get(CRED_TARGET);
    const config = readConfig(m.root);
    sys.state.listening.add(config.ports.ui);
    await runWizard({ root: m.root, answers: m.answers, sys, launch: m.launch });
    assert.equal(fs.readFileSync(path.join(m.root, 'config.json'), 'utf8'), first);
    assert.equal(sys.creds.get(CRED_TARGET), token);
    assert.equal(sys.calls.filter((c) => c.name === 'cred.set').length, 1);
    assert.equal(sys.calls.filter((c) => c.name === 'clipboard').length, 1);
    assert.equal(sys.tasks.size, 1);
    assert.equal(sys.calls.filter((c) => c.name === 'startService').length, 1);
    assert.equal(readConfig(m.root).projects.length, 2);
  } finally { m.cleanup(); }
});

test('a rerun repairs a missing task, a stale hash and a lost credential, and adds a new project', async () => {
  const m = machine(); const sys = makeFakeSystem();
  try {
    await runWizard({ root: m.root, answers: m.answers, sys, launch: m.launch });
    sys.tasks.clear();
    const stored = sys.creds.get(CRED_TARGET);
    const stale = readConfig(m.root); stale.connector.tokenSha256 = 'a'.repeat(64);
    fs.writeFileSync(path.join(m.root, 'config.json'), JSON.stringify(stale));
    await runWizard({ root: m.root, answers: m.answers, sys, launch: m.launch });
    assert.ok(sys.tasks.has(TASK_NAME));
    assert.equal(sys.creds.get(CRED_TARGET), stored, 'the stored token is kept');
    assert.equal(readConfig(m.root).connector.tokenSha256, sha(stored));

    sys.creds.delete(CRED_TARGET);
    const charlie = path.join(m.base, 'charlie'); fs.mkdirSync(charlie);
    await runWizard({ root: m.root, answers: { ...m.answers, projects: [{ code: 'charlie', name: 'Charlie', path: charlie }] }, sys, launch: m.launch });
    const config = readConfig(m.root);
    assert.deepEqual(config.projects.map((p) => p.code).sort(), ['alpha', 'bravo', 'charlie']);
    assert.notEqual(sys.creds.get(CRED_TARGET), stored);
    assert.equal(config.connector.tokenSha256, sha(sys.creds.get(CRED_TARGET)));
  } finally { m.cleanup(); }
});

test('dry run changes nothing: no files, no credential, no task, no service, no git', async () => {
  const m = machine(); const real = makeFakeSystem(); const said = [];
  try {
    const sys = dryRunSystem(real, (t) => said.push(t));
    const report = await runWizard({ root: m.root, answers: { ...m.answers, gitInit: true, runServe: true }, sys, launch: m.launch });
    assert.equal(fs.existsSync(m.root), false);
    assert.equal(real.creds.size, 0);
    assert.equal(real.tasks.size, 0);
    assert.deepEqual(real.calls, []);
    assert.equal(fs.existsSync(path.join(m.alpha, '.git')), false);
    assert.ok(said.some((s) => /logon task/.test(s)) && said.some((s) => /tailscale serve/.test(s)));
    assert.equal(report.dryRun, true);
  } finally { m.cleanup(); }
});

test('git init happens only when asked, and sign-in is left to the buyer', async () => {
  const m = machine(); const sys = makeFakeSystem();
  try {
    const report = await runWizard({ root: m.root, answers: m.answers, sys, launch: m.launch });
    assert.equal(sys.calls.filter((c) => c.name === 'gitInit').length, 0);
    assert.ok(report.manual.some((t) => /signed in to claude: run "claude" in your own terminal/.test(t)));
    assert.ok(report.manual.some((t) => /codex login/.test(t)));
    assert.equal(sys.calls.filter((c) => c.name === 'liveCheck').length, 0, 'the live check uses the buyer plan, so it needs a yes');
    await runWizard({ root: m.root, answers: { ...m.answers, gitInit: true, liveCheck: true }, sys, launch: m.launch });
    assert.equal(sys.calls.filter((c) => c.name === 'gitInit').length, 2);
    assert.equal(sys.calls.filter((c) => c.name === 'liveCheck').length, 2);
  } finally { m.cleanup(); }
});

test('missing engines warn with the vendor link and setup continues', async () => {
  const m = machine(); const sys = makeFakeSystem({ noEngines: true });
  try {
    const report = await runWizard({ root: m.root, answers: m.answers, sys, launch: m.launch });
    assert.ok(report.warnings.some((w) => w.includes('https://docs.claude.com')));
    assert.ok(report.warnings.some((w) => w.includes('https://github.com/openai/codex')));
    assert.ok(fs.existsSync(path.join(m.root, 'config.json')));
  } finally { m.cleanup(); }
});

test('bad answers fail before anything is written', async () => {
  const m = machine(); const sys = makeFakeSystem();
  try {
    await assert.rejects(runWizard({ root: m.root, answers: { projects: [{ code: 'x', path: 'relative/path' }], loopback: false }, sys, launch: m.launch }), /absolute path/);
    await assert.rejects(runWizard({ root: m.root, answers: { projects: [{ code: 'gone', path: path.join(m.base, 'nope') }], loopback: false }, sys, launch: m.launch }), /does not exist/);
    assert.equal(fs.existsSync(path.join(m.root, 'config.json')), false);
    assert.equal(sys.creds.size, 0);
  } finally { m.cleanup(); }
});

test('ports skip busy defaults and an existing config keeps its ports', async () => {
  const m = machine(); const sys = makeFakeSystem({ busyPorts: [47311] });
  try {
    await runWizard({ root: m.root, answers: m.answers, sys, launch: m.launch });
    const ports = readConfig(m.root).ports;
    assert.deepEqual(ports, { ui: 47312, connector: 47313 });
    const again = makeFakeSystem({ busyPorts: [47312] });
    again.creds.set(CRED_TARGET, sys.creds.get(CRED_TARGET));
    await runWizard({ root: m.root, answers: m.answers, sys: again, launch: m.launch });
    assert.deepEqual(readConfig(m.root).ports, ports);
  } finally { m.cleanup(); }
});
