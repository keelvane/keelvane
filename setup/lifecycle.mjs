// Install payload, backup, update with rollback, and uninstall.
// Uninstall removes only what Keelvane created. It never recurses over the install root, never touches a
// project folder (or anything that contains or sits inside one) and never touches the vendor CLIs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { validateConfig } from '../config.mjs';
import { layout, defaultRoot, CRED_TARGET, TASK_NAME, SERVE_PORT } from './system.mjs';
import { readLaunch, writeLaunch } from './wizard.mjs';

const stamp = (now = new Date()) => now.toISOString().replace(/[:.]/g, '-');

// Release layout: <payload>/node/node.exe, <payload>/app (the package + node_modules), <payload>/payload.json.
export function findPayload(appFile) {
  const payload = path.resolve(path.dirname(appFile), '..');
  const file = path.join(payload, 'payload.json');
  if (!fs.existsSync(file) || !fs.existsSync(path.join(payload, 'node', 'node.exe'))) return null;
  return { dir: payload, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const norm = (p) => path.resolve(p).toLowerCase();
const inside = (child, parent) => {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// A version becomes a folder name that is later removed recursively, so it must be a plain version string.
function appFolder(L, version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(version) || version.includes('..')) throw new Error(`Refusing unsafe version "${version}".`);
  const dir = path.join(L.app, version);
  if (!inside(dir, L.app) || norm(dir) === norm(L.app)) throw new Error(`Refusing unsafe app folder for version "${version}".`);
  return dir;
}

const ownsRoot = (L) => fs.existsSync(L.current) || fs.existsSync(L.config);

export function installPayload({ root, payload }) {
  const L = layout(root);
  const appDir = appFolder(L, payload.version);
  const cur = readLaunch(root);
  if (cur && cur.version === payload.version && fs.existsSync(appDir)) return { node: cur.node, appDir, version: payload.version };
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.cpSync(path.join(payload.dir, 'app'), appDir, { recursive: true });
  fs.cpSync(path.join(payload.dir, 'node'), L.node, { recursive: true });
  return { node: path.join(L.node, 'node.exe'), appDir, version: payload.version };
}

function readConfig(root) {
  const L = layout(root);
  const raw = JSON.parse(fs.readFileSync(L.config, 'utf8'));
  return validateConfig(raw).config;
}

const sqlQuote = (p) => `'${p.replaceAll("'", "''")}'`;

// A consistent copy of the ledger even while the service is writing.
export function copyLedger(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { force: true });
  const db = new DatabaseSync(from, { readOnly: true });
  try { db.exec(`VACUUM INTO ${sqlQuote(to)}`); } finally { db.close(); }
}

export function backup({ root, sys, outDir, now = new Date() }) {
  const L = layout(root);
  const config = readConfig(root);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-backup-'));
  try {
    fs.copyFileSync(L.config, path.join(stage, 'config.json'));
    const ledger = path.join(config.dataDir, 'keelvane.sqlite');
    if (fs.existsSync(ledger)) copyLedger(ledger, path.join(stage, 'keelvane.sqlite'));
    const dest = path.join(outDir || L.backups, `keelvane-backup-${stamp(now)}.zip`);
    sys.zip(stage, dest);
    return dest;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

// Copies the new app next to the old one, backs up the ledger, switches current.json, keeps one previous.
export async function update({ root, sys, newAppDir, now = new Date() }) {
  const L = layout(root);
  const pkg = JSON.parse(fs.readFileSync(path.join(newAppDir, 'package.json'), 'utf8'));
  if (!fs.existsSync(path.join(newAppDir, 'server.mjs'))) throw new Error(`${newAppDir} does not look like a Keelvane app folder.`);
  const cur = readLaunch(root);
  if (cur && cur.version === pkg.version) return { changed: false, version: pkg.version };
  const config = readConfig(root);
  if (sys.dryRun) return { changed: false, dryRun: true, version: pkg.version, note: 'dry run: nothing was changed' };
  if (inside(newAppDir, L.app)) throw new Error('Point update at a folder outside the install.');
  const target = appFolder(L, pkg.version);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(newAppDir, target, { recursive: true });
  const ledger = path.join(config.dataDir, 'keelvane.sqlite');
  let backupFile = null;
  if (fs.existsSync(ledger)) {
    backupFile = path.join(config.dataDir, 'backups', `pre-${pkg.version}-${stamp(now)}.sqlite`);
    copyLedger(ledger, backupFile);
  }
  const wasUp = await sys.portListening(config.ports.ui);
  if (wasUp) sys.stopService({ launch: L.launch });
  writeLaunch(root, { node: cur?.node || process.execPath, appDir: target, version: pkg.version });
  const link = JSON.parse(fs.readFileSync(L.current, 'utf8'));
  if (cur) link.previous = { version: cur.version, appDir: path.relative(root, cur.appDir) };
  fs.writeFileSync(L.current, JSON.stringify(link, null, 2));
  // Keep only the new and the previous app folder.
  const keep = new Set([pkg.version, cur?.version]);
  for (const name of fs.existsSync(L.app) ? fs.readdirSync(L.app) : []) {
    const full = path.join(L.app, name);
    if (fs.statSync(full).isDirectory() && !keep.has(name)) fs.rmSync(full, { recursive: true, force: true });
  }
  if (wasUp) sys.startService({ node: cur?.node || process.execPath, launch: L.launch, cwd: root });
  return { changed: true, version: pkg.version, previous: cur?.version || null, backupFile };
}

export async function rollback({ root, sys }) {
  const L = layout(root);
  const link = JSON.parse(fs.readFileSync(L.current, 'utf8'));
  if (!link.previous) throw new Error('There is no previous version to roll back to.');
  if (sys.dryRun) return { dryRun: true, version: link.previous.version, note: 'dry run: nothing was changed' };
  const config = readConfig(root);
  const prev = { version: link.previous.version, appDir: path.resolve(root, link.previous.appDir) };
  if (!fs.existsSync(prev.appDir)) throw new Error(`Previous app folder is gone: ${prev.appDir}`);
  const cur = readLaunch(root);
  const wasUp = await sys.portListening(config.ports.ui);
  if (wasUp) sys.stopService({ launch: L.launch });
  writeLaunch(root, { node: cur.node, appDir: prev.appDir, version: prev.version });
  const next = JSON.parse(fs.readFileSync(L.current, 'utf8'));
  next.previous = { version: cur.version, appDir: path.relative(root, cur.appDir) };
  fs.writeFileSync(L.current, JSON.stringify(next, null, 2));
  if (wasUp) sys.startService({ node: cur.node, launch: L.launch, cwd: root });
  return { version: prev.version };
}

export async function uninstall({ root, sys, removeServe = false, removeData = false, log = () => {} }) {
  const L = layout(root);
  const result = { removed: [], kept: [], residue: [] };
  let config = null;
  try { config = readConfig(root); } catch { /* uninstall must work even with a broken config */ }
  if (!ownsRoot(L)) throw new Error(`${root} has no Keelvane config or app/current.json; refusing to remove anything from it.`);
  if (!config && !fs.existsSync(L.current) && norm(root) !== norm(defaultRoot())) throw new Error('The config is unreadable and there is no app/current.json; fix or restore config.json first.');
  const projectPaths = (config?.projects || []).map((p) => p.path);
  result.kept.push(...projectPaths.map((p) => `project folder ${p} (never touched)`));

  // A target is removable only if it is not a project folder, does not contain one and does not sit inside one.
  const safe = (target) => !projectPaths.some((p) => inside(p, target) || inside(target, p));
  const remove = (target, label) => {
    if (!fs.existsSync(target)) return;
    if (!safe(target)) { result.kept.push(`${label} ${target} (overlaps a project folder; left alone)`); return; }
    if (sys.dryRun) { result.removed.push(`[dry-run] would remove ${label} ${target}`); return; }
    try { fs.rmSync(target, { recursive: true, force: true }); result.removed.push(`${label} ${target}`); }
    catch (error) { result.residue.push(`${label} ${target} could not be removed (${error.code || error.message}); delete it after this process exits`); }
  };

  sys.stopService({ launch: L.launch });
  result.removed.push('service stopped');

  if (await sys.task.has(TASK_NAME)) { await sys.task.remove(TASK_NAME); result.removed.push(`logon task ${TASK_NAME}`); }
  if (removeServe && config?.connector.serveHost) { await sys.tailscale.unserve(); result.removed.push(`tailscale serve rule on port ${SERVE_PORT}`); }
  else if (config?.connector.serveHost) result.kept.push(`tailscale serve rule on port ${SERVE_PORT} (left in place; remove with: tailscale serve --https=${SERVE_PORT} off)`);
  if (await sys.cred.has(CRED_TARGET)) { await sys.cred.del(CRED_TARGET); result.removed.push(`Credential Manager entry ${CRED_TARGET}`); }

  // Explicit list: the install root itself is never removed recursively.
  for (const [target, label] of [[L.app, 'app folder'], [L.node, 'bundled runtime'], [L.launch, 'launcher'],
    [path.join(root, 'muse-setup-prompt.md'), 'file'], [path.join(root, 'tailscale-policy-fragments.json'), 'file']]) remove(target, label);

  const dataDir = config?.dataDir || L.data;
  if (removeData) {
    if (inside(dataDir, root)) remove(dataDir, 'data folder');
    else {
      // A data folder outside the install may be shared with other things: remove only our own files.
      for (const name of ['keelvane.sqlite', 'keelvane.sqlite-wal', 'keelvane.sqlite-shm', 'backups']) remove(path.join(dataDir, name), 'data item');
      if (!sys.dryRun) try { fs.rmdirSync(dataDir); } catch { /* not empty: left alone */ }
    }
    remove(L.backups, 'backups folder');
    remove(L.config, 'config');
    if (!sys.dryRun) try { fs.rmdirSync(root); result.removed.push(`install folder ${root}`); } catch { /* not empty: residue below */ }
  } else {
    result.kept.push(`data folder ${dataDir} (kept; removeData to delete)`);
    result.kept.push(`config ${L.config} (kept)`);
  }

  if (sys.dryRun) return result;
  // Residue report: anything we own that is still present.
  if (await sys.task.has(TASK_NAME)) result.residue.push(`logon task ${TASK_NAME} still registered`);
  if (await sys.cred.has(CRED_TARGET)) result.residue.push(`Credential Manager entry ${CRED_TARGET} still present`);
  if (removeServe) {
    const status = await sys.tailscale.serveStatus();
    if (config && status.includes(String(config.ports.connector))) result.residue.push('tailscale serve rule still points at the connector');
  }
  for (const [target, label] of [[L.app, 'app folder'], [L.node, 'bundled runtime'], [L.launch, 'launcher']]) {
    if (fs.existsSync(target) && !result.residue.some((r) => r.includes(target)) && !result.kept.some((k) => k.includes(target))) result.residue.push(`${label} ${target} still present`);
  }
  log(`uninstall: ${result.removed.length} removed, ${result.kept.length} kept, ${result.residue.length} residue`);
  return result;
}
