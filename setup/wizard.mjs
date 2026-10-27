// Setup wizard. Every step is idempotent: rerunning repairs (missing task, stale hash, new project) and never
// duplicates. All machine effects go through `sys`; pass dryRunSystem() to rehearse with no changes.
// Provider logins are never opened, read or stored: the buyer signs in to each CLI in their own terminal.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { validateConfig } from '../config.mjs';
import { newToken, policyFragments } from '../remote-setup.mjs';
import { layout, CRED_TARGET, TASK_NAME, SERVE_PORT } from './system.mjs';
import { runDoctor } from './doctor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const INSTALL_LINKS = {
  claude: 'https://docs.claude.com/en/docs/claude-code/setup',
  codex: 'https://github.com/openai/codex',
};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function writeLaunch(root, { node, appDir, version }, io = fsIO) {
  const L = layout(root);
  const rel = (p) => (path.relative(root, p).startsWith('..') || path.isAbsolute(path.relative(root, p)) ? p : path.relative(root, p));
  io.put(L.current, JSON.stringify({ version, appDir: rel(appDir), node: rel(node) }, null, 2));
  io.put(L.launch, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { pathToFileURL, fileURLToPath } from 'node:url';",
    'const root = path.dirname(fileURLToPath(import.meta.url));',
    "const cur = JSON.parse(fs.readFileSync(path.join(root, 'app', 'current.json'), 'utf8'));",
    "process.env.KEELVANE_CONFIG ||= path.join(root, 'config.json');",
    "await import(pathToFileURL(path.resolve(root, cur.appDir, 'server.mjs')).href);",
    '',
  ].join('\n'));
}

export const fsIO = {
  put(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  },
  mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
};
export const dryIO = { put() {}, mkdir() {} };

export function readLaunch(root) {
  const L = layout(root);
  try {
    const cur = JSON.parse(fs.readFileSync(L.current, 'utf8'));
    return { ...cur, appDir: path.resolve(root, cur.appDir), node: path.resolve(root, cur.node) };
  } catch { return null; }
}

async function pickPorts(sys, start = 47310) {
  for (let ui = start; ui < start + 200; ui += 2) {
    if (await sys.isPortFree(ui) && await sys.isPortFree(ui + 1)) return { ui, connector: ui + 1 };
  }
  throw new Error('No free pair of ports found near 47310.');
}

function museProjects(config) {
  return config.projects.filter((p) => p.muse);
}

function renderPrompt(config, url, capability) {
  const template = fs.readFileSync(path.join(PKG, 'templates', 'muse-setup-prompt.md'), 'utf8');
  const list = museProjects(config).map((p) => `- ${p.name} (code: ${p.code})`).join('\n') || '- (none yet: add a project with Muse access in config.json)';
  return template.replaceAll('{{URL}}', url).replaceAll('{{CAPABILITY}}', capability || '(set by tailscale step)').replaceAll('{{PROJECTS}}', list);
}

export async function runWizard({ root, answers = {}, sys, log = () => {}, launch }) {
  const L = layout(root);
  const io = sys.dryRun ? dryIO : fsIO;
  const report = { steps: [], warnings: [], manual: [], dryRun: Boolean(sys.dryRun) };
  const step = (name, detail) => { report.steps.push({ name, detail }); log(`${name}: ${detail}`); };
  const warn = (text) => { report.warnings.push(text); log(`warning: ${text}`); };
  const manual = (text) => { report.manual.push(text); log(`you do: ${text}`); };

  let raw = {};
  if (fs.existsSync(L.config)) {
    try { raw = JSON.parse(fs.readFileSync(L.config, 'utf8')); }
    catch { throw new Error(`${L.config} is not valid JSON. Fix or remove it, then rerun setup.`); }
  }

  // 1. Preflight
  const ports = raw.ports || await pickPorts(sys, answers.portStart);
  const dataDir = raw.dataDir || answers.dataDir || L.data;
  io.mkdir(dataDir);
  if (!sys.dryRun) {
    const probe = path.join(dataDir, `.write-test-${process.pid}`);
    try { fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe); }
    catch (error) { throw new Error(`The data directory ${dataDir} is not writable: ${error.message}`); }
  }
  step('preflight', `${sys.osRelease()}; ports ${ports.ui}/${ports.connector}; data ${dataDir}`);

  // 2. Engines (never log in, never read credentials)
  const tested = JSON.parse(fs.readFileSync(path.join(PKG, 'engines', 'tested-versions.json'), 'utf8'));
  for (const name of ['claude', 'codex']) {
    const bin = sys.findBin(name, raw.engines?.[name]?.bin);
    if (!bin) {
      warn(`${name} was not found. Install it from ${INSTALL_LINKS[name]} and sign in yourself by running "${name}${name === 'codex' ? ' login' : ''}" in your own terminal.`);
      continue;
    }
    const version = sys.binVersion(bin);
    const known = tested[name] || [];
    const note = !known.length ? 'tested-version list not yet recorded' : (known.some((v) => String(version).includes(v)) ? 'tested' : 'NOT in the tested list');
    step(`engine ${name}`, `${bin} (${version || 'version unknown'}; ${note})`);
    if (known.length && !known.some((v) => String(version).includes(v))) warn(`${name} ${version} is newer or older than the tested versions.`);
    manual(`Make sure you are signed in to ${name}: run "${name}${name === 'codex' ? ' login' : ''}" in your own terminal if you have not.`);
    if (answers.liveCheck) {
      const live = sys.liveCheck(name, bin);
      step(`live check ${name}`, live.ok ? 'ok' : `failed: ${live.detail}`);
    }
  }

  // 3. Projects (merge by code; existing entries are updated, others kept)
  const byCode = new Map((raw.projects || []).map((p) => [String(p.code).toLowerCase(), p]));
  for (const p of answers.projects || []) {
    const code = String(p.code).toLowerCase();
    byCode.set(code, { ...byCode.get(code), ...p, code, muse: p.muse === undefined ? (byCode.get(code)?.muse ?? (p.private ? null : true)) : p.muse });
  }
  const projects = [...byCode.values()];
  for (const p of projects) {
    if (typeof p.path === 'string' && path.isAbsolute(p.path) && !fs.existsSync(p.path)) {
      if (p.create) io.mkdir(p.path);
      else throw new Error(`Project folder does not exist: ${p.path}`);
    }
  }
  const connector = { ...(raw.connector || {}), enabled: answers.connector === false ? false : (raw.connector?.enabled ?? true) };
  if (answers.capability) connector.capability = answers.capability;
  const draft = { schema: 1, dataDir, ports, projects, engines: raw.engines, connector, protectedGlobs: raw.protectedGlobs };
  const first = validateConfig(draft);
  if (first.errors.length) throw new Error(`The answers make an invalid config:\n  ${first.errors.join('\n  ')}`);
  for (const p of first.config.projects) {
    let state = sys.gitState(p.path);
    if (answers.gitInit && !state.repo) { sys.gitInit(p.path); state = sys.dryRun ? state : sys.gitState(p.path); }
    step(`project ${p.code}`, `${p.path}${p.private ? ' (private)' : ''}${p.muse ? ' (Muse)' : ''}${state.repo === false ? ' (not a Git repo: changes are not tracked)' : ''}`);
  }
  let config = first.config;

  // 4. Connector token (Credential Manager holds it; config holds only the hash)
  if (config.connector.enabled) {
    const stored = await sys.cred.get(CRED_TARGET);
    if (stored && !answers.rotateToken) {
      const hash = sha256(stored.trim());
      if (config.connector.tokenSha256 !== hash) {
        config = { ...config, connector: { ...config.connector, tokenSha256: hash } };
        step('token', 'stored token kept; config hash repaired to match it');
      } else step('token', 'already stored; kept');
    } else {
      const { token, hash } = newToken();
      await sys.cred.set(CRED_TARGET, token);
      config = { ...config, connector: { ...config.connector, tokenSha256: hash } };
      let copied = true;
      try { await sys.clipboard(token); } catch { copied = false; }
      step('token', 'new token stored in Credential Manager');
      manual(sys.dryRun ? 'Dry run: a real run would put a new token on your clipboard once for pasting into Muse.' : copied
        ? 'The token is on your clipboard once: paste it into the Muse Secure Credentials Store now. It is never printed.'
        : 'Clipboard unavailable, so the token could not be handed to you. Fix the clipboard and rerun setup with rotateToken to issue a new one.');
    }
  }

  // 5. Tailscale (optional; required for Muse)
  if (answers.tailscale && config.connector.enabled) {
    const ts = await sys.tailscale.status();
    if (!ts.ok) warn(`Tailscale step skipped: ${ts.reason}`);
    else {
      const suffix = ts.serveHost.split('.').slice(1).join('.');
      const capability = answers.capability || config.connector.capability || `${suffix}/cap/keelvane-muse`;
      config = { ...config, connector: { ...config.connector, serveHost: ts.serveHost, capability } };
      const cmd = `tailscale serve --bg --https=${SERVE_PORT} --accept-app-caps=${capability} http://127.0.0.1:${ports.connector}`;
      if (answers.runServe === true) { await sys.tailscale.serve({ capability, connectorPort: ports.connector }); step('tailscale serve', `published on https://${ts.serveHost}:${SERVE_PORT}`); }
      else manual(`Inspect your existing "tailscale serve status" first, then run: ${cmd}`);
      const fragFile = path.join(root, 'tailscale-policy-fragments.json');
      io.put(fragFile, JSON.stringify(policyFragments(ts, capability), null, 2));
      manual(`Merge the grant in ${fragFile} into your tailnet policy in the admin console (read every existing rule and test first; it is additive, not a replacement).`);
    }
  }
  io.put(L.config, JSON.stringify(config, null, 2));
  step('config', `${L.config} written`);

  // 6. Muse setup prompt
  const url = config.connector.serveHost ? `https://${config.connector.serveHost}:${SERVE_PORT}` : `https://<this-machine>.<your-tailnet>.ts.net:${SERVE_PORT}`;
  io.put(path.join(root, 'muse-setup-prompt.md'), renderPrompt(config, url, config.connector.capability));
  step('muse prompt', `${path.join(root, 'muse-setup-prompt.md')} (paste into Muse; one side chat per project)`);
  if (config.connector.enabled && !museProjects(config).length) warn('No project is exposed to Muse; the connector will have nothing to serve.');

  // 7. Autostart and start
  const run = launch || readLaunch(root);
  if (run && !sys.dryRun) writeLaunch(root, run);
  if (!run) warn('No launch target known; the service cannot be started until the app is installed.');
  else if (answers.autostart) {
    await sys.task.create({ name: TASK_NAME, execute: 'conhost.exe', argument: `--headless "${run.node}" "${L.launch}"`, workDir: root });
    step('autostart', `logon task ${TASK_NAME} registered (per-user, no admin)`);
  } else step('autostart', 'not requested');
  if (run && answers.start !== false) {
    if (await sys.portListening(ports.ui)) manual('The service is already running; restart it to apply config changes.');
    else {
      sys.startService({ node: run.node, launch: L.launch, cwd: root });
      step('service', (await sys.waitPort?.(ports.ui)) === false ? 'started, but not listening yet; see the doctor' : 'started');
    }
    if (answers.openUi !== false) sys.openUrl(`http://127.0.0.1:${ports.ui}/`);
  }

  // 8. Doctor
  report.doctor = await runDoctor({ root, sys, appDir: run?.appDir || PKG, config: sys.dryRun ? config : undefined, loopback: answers.loopback !== false });
  report.config = config;
  return report;
}
