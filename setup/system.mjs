// Every effect on the machine sits behind one `sys` object, so the wizard, doctor and uninstall can be tested
// with fakes and rehearsed with dryRunSystem(). Real effects: Credential Manager, a logon task, tailscale serve,
// clipboard, child processes. Names are fenced: credentials and tasks must start with "Keelvane".
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { queryTailscale, tailscaleExe } from '../remote-setup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CRED_TARGET = 'Keelvane/connector-token';
export const TASK_NAME = 'Keelvane';
export const SERVE_PORT = 8443;

export function layout(root) {
  return {
    root,
    config: path.join(root, 'config.json'),
    data: path.join(root, 'data'),
    app: path.join(root, 'app'),
    node: path.join(root, 'node'),
    current: path.join(root, 'app', 'current.json'),
    launch: path.join(root, 'launch.mjs'),
    backups: path.join(root, 'backups'),
  };
}

export function defaultRoot(env = process.env) {
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Keelvane');
}

const POWERSHELL = 'powershell.exe';
function ps(file, args, input) {
  return execFileSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, file), ...args],
    { encoding: 'utf8', input, windowsHide: true, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
}
const exit3 = (fn) => { try { fn(); return true; } catch (error) { if (error.status === 3) return false; throw error; } };

function run(file, args, opts = {}) {
  return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// .cmd shims need cmd.exe. Quote every part ourselves and refuse characters cmd would reinterpret.
export function runBin(bin, args, opts = {}) {
  if (!/\.cmd$/i.test(bin)) return run(bin, args, opts);
  for (const part of [bin, ...args]) if (/["%\r\n]/.test(part)) throw new Error('unsupported character in a command argument');
  const line = [bin, ...args].map((a) => `"${a}"`).join(' ');
  return run('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
}

function whereBin(name) {
  try {
    const out = run('where.exe', [name]).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return out.find((p) => /\.(exe|cmd)$/i.test(p)) || out[0] || null;
  } catch { return null; }
}

const STANDARD = {
  claude: () => [path.join(os.homedir(), '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')],
  codex: () => [path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'), path.join(os.homedir(), '.codex', 'bin', 'codex.exe')],
};

export function realSystem() {
  const sys = {
    dryRun: false,
    platform: process.platform,
    osRelease: () => `${os.type()} ${os.release()}`,
    isPortFree: (port) => new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    }),
    portListening: (port) => new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
    }),
    // The service is spawned detached, so setup waits for it before the doctor checks ports.
    waitPort: async (port, ms = 15000) => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) if (await sys.portListening(port)) return true;
      return false;
    },
    findBin(name, configured) {
      if (configured && configured !== 'auto') return fs.existsSync(configured) ? configured : null;
      return whereBin(name) || (STANDARD[name]?.() || []).find((p) => fs.existsSync(p)) || null;
    },
    binVersion(bin) {
      try { return runBin(bin, ['--version']).trim().split(/\r?\n/)[0] || null; } catch { return null; }
    },
    liveCheck(name, bin) {
      try {
        const args = name === 'claude' ? ['-p', 'Reply with the single word ok'] : ['exec', 'Reply with the single word ok'];
        const out = runBin(bin, args, { timeout: 120000 });
        return { ok: /ok/i.test(out), detail: out.trim().slice(0, 80) };
      } catch (error) { return { ok: false, detail: String(error.message).split('\n')[0] }; }
    },
    cred: {
      has: async (target) => exit3(() => ps('cred.ps1', ['-Action', 'has', '-Target', target])),
      get: async (target) => { try { return ps('cred.ps1', ['-Action', 'get', '-Target', target]); } catch (e) { if (e.status === 3) return null; throw e; } },
      set: async (target, secret) => { ps('cred.ps1', ['-Action', 'set', '-Target', target], secret); },
      del: async (target) => { ps('cred.ps1', ['-Action', 'del', '-Target', target]); },
    },
    task: {
      has: async (name) => exit3(() => ps('task.ps1', ['-Action', 'has', '-Name', name])),
      create: async ({ name, execute, argument, workDir }) => { ps('task.ps1', ['-Action', 'create', '-Name', name, '-Execute', execute, '-Argument', argument, '-WorkDir', workDir]); },
      remove: async (name) => { ps('task.ps1', ['-Action', 'remove', '-Name', name]); },
    },
    tailscale: {
      status: async () => { try { return { ok: true, ...queryTailscale() }; } catch (error) { return { ok: false, reason: error.message }; } },
      serveStatus: async () => { try { return run(tailscaleExe(), ['serve', 'status']); } catch { return ''; } },
      serve: async ({ capability, connectorPort }) => {
        run(tailscaleExe(), ['serve', '--bg', `--https=${SERVE_PORT}`, `--accept-app-caps=${capability}`, `http://127.0.0.1:${connectorPort}`]);
      },
      // Only our own port is switched off. Never `serve reset`, which removes unrelated publications.
      unserve: async () => { run(tailscaleExe(), ['serve', `--https=${SERVE_PORT}`, 'off']); },
    },
    // Kept out of Win+V history and cloud clipboard sync; the text arrives on stdin, never on a command line.
    clipboard: async (text) => {
      const script = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object Windows.Forms.DataObject; $d.SetText([Console]::In.ReadToEnd().Trim());"
        + " foreach ($f in 'ExcludeClipboardContentFromMonitorProcessing') { $d.SetData($f, (New-Object IO.MemoryStream (,[byte[]](1,0,0,0)))) }"
        + " foreach ($f in 'CanIncludeInClipboardHistory','CanUploadToCloudClipboard') { $d.SetData($f, (New-Object IO.MemoryStream (,[byte[]](0,0,0,0)))) }"
        + " [Windows.Forms.Clipboard]::SetDataObject($d, $true)";
      execFileSync(POWERSHELL, ['-NoProfile', '-STA', '-Command', script], { input: text, windowsHide: true, timeout: 30000 });
    },
    gitInit(dir) {
      run('git', ['init'], { cwd: dir });
      run('git', ['add', '-A'], { cwd: dir });
      run('git', ['-c', 'user.name=Keelvane', '-c', 'user.email=keelvane@localhost', 'commit', '--allow-empty', '-m', 'Initial commit'], { cwd: dir });
    },
    gitState(dir) {
      try {
        const out = run('git', ['status', '--porcelain'], { cwd: dir });
        return { repo: true, dirty: out.trim().length > 0 };
      } catch { return { repo: false, dirty: null }; }
    },
    startService({ node, launch, cwd }) {
      const child = spawn(node, [launch], { cwd, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    },
    // Matches only node processes whose command line runs this install's launch.mjs or anything under its app folder
    // (trailing separator, so a sibling "app2" cannot match), then waits for them to exit so files are unlocked.
    stopService({ launch }) {
      const appDir = path.join(path.dirname(launch), 'app') + path.sep;
      const script = '$o = [StringComparison]::OrdinalIgnoreCase; $p = @(Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -and ($_.CommandLine.IndexOf($env:KV_LAUNCH, $o) -ge 0 -or $_.CommandLine.IndexOf($env:KV_APPDIR, $o) -ge 0) }); foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }; foreach ($x in $p) { Wait-Process -Id $x.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }';
      execFileSync(POWERSHELL, ['-NoProfile', '-Command', script], { windowsHide: true, env: { ...process.env, KV_LAUNCH: launch, KV_APPDIR: appDir }, timeout: 40000 });
    },
    openUrl: (url) => { spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); },
    zip(srcDir, destZip) {
      fs.mkdirSync(path.dirname(destZip), { recursive: true });
      execFileSync(POWERSHELL, ['-NoProfile', '-Command', 'Compress-Archive -Path (Join-Path $env:KV_SRC "*") -DestinationPath $env:KV_DEST -Force'],
        { windowsHide: true, env: { ...process.env, KV_SRC: srcDir, KV_DEST: destZip }, timeout: 120000 });
    },
  };
  return sys;
}

// Rehearsal: reads are real (ports, binaries, Tailscale status); every change is logged and skipped.
export function dryRunSystem(real = realSystem(), log = () => {}) {
  const say = (what) => log(`[dry-run] would ${what}`);
  return {
    ...real,
    dryRun: true,
    waitPort: async () => true,
    cred: { ...real.cred, set: async (t) => say(`store a credential at ${t}`), del: async (t) => say(`delete the credential at ${t}`) },
    task: { ...real.task, create: async (s) => say(`register logon task ${s.name}`), remove: async (n) => say(`remove logon task ${n}`) },
    tailscale: { ...real.tailscale, serve: async (s) => say(`run tailscale serve for port ${s.connectorPort}`), unserve: async () => say(`run tailscale serve --https=${SERVE_PORT} off`) },
    clipboard: async () => say('copy the token to the clipboard'),
    gitInit: (d) => say(`git init ${d}`),
    startService: () => say('start the service'),
    stopService: () => say('stop the service'),
    openUrl: (u) => say(`open ${u}`),
    zip: (s, d) => say(`zip ${s} to ${d}`),
    liveCheck: (n) => { say(`run a live prompt on ${n}`); return { ok: true, detail: 'skipped' }; },
  };
}
