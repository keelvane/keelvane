// remote-setup.mjs: the Tailscale step of setup. Run it yourself after signing in to Tailscale.
// It writes connector.serveHost, connector.capability and connector.tokenSha256 into your Keelvane config,
// then prints the exact policy and `tailscale serve` commands for you to review and run.
// It never logs in to anything and never stores the token it prints.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configPath, validateConfig } from './config.mjs';

const TAILSCALE_EXE = process.env.TAILSCALE_EXE ||
  (existsSync('C:\\Program Files\\Tailscale\\tailscale.exe') ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale');
const SERVE_PORT = 8443;
const DENY_PORTS = [22, 80, 443, 445, 3389];
const CAP_RE = /^[a-z0-9.-]+\.[a-z]{2,}\/cap\/[a-z0-9-]+$/i;
const USAGE = 'Usage: node remote-setup.mjs [--capability <domain.tld/cap/name>] [--rotate | --status | --disable]';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function loadRaw(file) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* fall through */ }
  fail(`Config file ${file} is not valid JSON; fix or remove it first.`);
}

function writeRaw(file, raw) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
  renameSync(tmp, file);
}

// Throws an Error with a plain reason; the wizard and doctor use this so they can carry on without Tailscale.
export function queryTailscale() {
  let stdout;
  try {
    stdout = execFileSync(TAILSCALE_EXE, ['status', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  } catch {
    throw new Error('Could not run tailscale status --json. Is Tailscale installed and on PATH?');
  }
  let status;
  try { status = JSON.parse(stdout); } catch { throw new Error('Tailscale status output was not valid JSON.'); }
  if (status.BackendState !== 'Running') throw new Error('Tailscale is not running and signed in on this machine.');
  const self = status.Self || {};
  const dnsName = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '').toLowerCase() : '';
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  const tailnetIp = ips.find((ip) => typeof ip === 'string' && ip.includes('.')) || '';
  if (!dnsName) throw new Error('Could not determine the Tailscale DNS name for this machine.');
  if (!tailnetIp) throw new Error('Could not determine the tailnet IP for this machine.');
  const peers = Object.values(status.Peer || {})
    .map((peer) => ({ ip: (Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs : []).find((ip) => typeof ip === 'string' && ip.includes('.')) || '' }))
    .filter((peer) => peer.ip);
  return { serveHost: dnsName, tailnetIp, peers };
}

export function readTailscale() {
  try { return queryTailscale(); } catch (error) { fail(error.message); }
}

export const tailscaleExe = () => TAILSCALE_EXE;

export function newToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}

// Fragments to merge into the existing tailnet policy, never a replacement. The tests block makes
// the admin console refuse to save a policy where an older broad rule still lets Muse reach more.
export function policyFragments(ts, capability) {
  const sub = `tcp:${SERVE_PORT}`;
  const tests = [{
    src: 'tag:muse',
    accept: [`${ts.tailnetIp}:${SERVE_PORT}`],
    deny: DENY_PORTS.map((port) => `${ts.tailnetIp}:${port}`),
  }];
  for (const peer of ts.peers || []) tests[0].deny.push(...DENY_PORTS.map((port) => `${peer.ip}:${port}`));
  return {
    tagOwners: { 'tag:muse': ['autogroup:admin'] },
    hosts: { 'keelvane-host': ts.tailnetIp },
    grants: [{ src: ['tag:muse'], dst: ['keelvane-host'], ip: [sub], app: { [capability]: [{}] } }],
    tests,
  };
}

function printNextSteps(config, ts) {
  const { connector, ports } = config;
  console.log('');
  console.log('Step 0, inspect before changing anything: in the Tailscale admin console open Access controls and read every grant, ACL and test; run tailscale serve status on this machine and note existing publications.');
  console.log('Step 1: ADD these entries to your existing tailnet policy. Do not replace the file. Merge each key into the same-named section.');
  console.log(JSON.stringify(policyFragments(ts, connector.capability), null, 2));
  console.log('Policy rules only add access, so an existing broad rule still lets a tagged Muse device reach this machine. The tests block is the check: if the console refuses to save, narrow the broad rule.');
  console.log('Also turn on MagicDNS and HTTPS certificates in the admin console DNS page; tailscale serve needs both.');
  console.log('');
  console.log('Step 2: give the Muse device its own tailnet identity, then tag it tag:muse in the Machines page. Do not sign Muse in as the owner.');
  console.log('');
  console.log('Step 3: on this machine, after Step 2:');
  console.log(`  tailscale serve --bg --https=${SERVE_PORT} --accept-app-caps=${connector.capability} http://127.0.0.1:${ports.connector}`);
  console.log('  (needs Tailscale 1.92 or newer. Keelvane refuses requests that lack the capability header)');
  console.log(`Connector base URL: https://${connector.serveHost}:${SERVE_PORT}/muse/v1`);
  console.log(`OpenAPI URL: https://${connector.serveHost}:${SERVE_PORT}/muse/v1/openapi.json`);
  console.log('Auth: Bearer <token>');
  console.log('');
  console.log(`Rollback: node remote-setup.mjs --disable; then tailscale serve --https=${SERVE_PORT} off. Never run tailscale serve reset; it removes unrelated publications.`);
}

function main() {
  const args = process.argv.slice(2);
  let capability = null;
  let flag = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--capability' && args[i + 1]) { capability = args[i + 1]; i += 1; }
    else if (['--rotate', '--status', '--disable'].includes(args[i]) && !flag) flag = args[i];
    else { console.error(USAGE); process.exit(2); }
  }
  const file = configPath();
  const raw = loadRaw(file);
  const connector = { ...(raw.connector || {}) };

  if (flag === '--status') {
    console.log(`config: ${file}`);
    console.log(`connector enabled: ${connector.enabled !== false}`);
    console.log(`serveHost: ${connector.serveHost || '(not set)'}`);
    console.log(`capability: ${connector.capability || '(not set)'}`);
    console.log(`token hash set: ${connector.tokenSha256 ? 'yes' : 'no'}`);
    return;
  }
  if (flag === '--disable') {
    writeRaw(file, { ...raw, connector: { ...connector, enabled: false } });
    console.log('Muse connector disabled. Now run: tailscale serve --https=8443 off');
    return;
  }

  const chosen = capability || connector.capability;
  if (!chosen || !CAP_RE.test(chosen)) fail('Choose your own capability name once, for example --capability yourdomain.com/cap/keelvane-muse');
  const ts = readTailscale();
  let token = null;
  let hash = connector.tokenSha256;
  if (flag === '--rotate' || !hash) {
    ({ token, hash } = newToken());
  }
  const next = { ...raw, connector: { ...connector, enabled: true, serveHost: ts.serveHost, capability: chosen, tokenSha256: hash } };
  const { config, errors } = validateConfig(next);
  if (errors.length) fail(`Config would be invalid:\n  ${errors.join('\n  ')}`);
  writeRaw(file, next);
  if (token) {
    console.log('New Muse token (shown only now, never stored anywhere):');
    console.log(token);
    console.log('Put it into the Muse connector credentials as a Bearer token.');
  }
  printNextSteps(config, ts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
