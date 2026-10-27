// Host-side tool executor. Every call goes through policy.decide first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { decide, resolveTargetPath, projectRoot, redactGuarded, isGuarded } from './policy.mjs';
import { listSkillsTool, loadSkillTool } from './skills.mjs';
import { gitStatusTool, gitDiffTool, gitCommitTool } from './git.mjs';


const MAX_READ_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_MATCHES = 200;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

function target(rawPath, session) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new Error('path is required');
  const resolved = resolveTargetPath(rawPath, session);
  if (!resolved) throw new Error(`unknown project: ${session?.project}`);
  return resolved.absPath;
}

function readFileTool(args, session) {
  const file = target(args.path, session);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('path is not a file');
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 8192).includes(0)) return `[binary file, ${bytes.length} bytes; read_file only returns text]`;
  const text = bytes.toString('utf8');
  const lines = text.split(/\r\n|\r|\n/);
  const offset = Math.max(0, Number(args.offset) || 0);
  const limit = args.limit ? Math.max(1, Number(args.limit)) : lines.length;
  const slice = lines.slice(offset, offset + limit);
  const numbered = slice
    .map((line, i) => `${offset + i + 1}\t${line}`)
    .join('\n');
  if (Buffer.byteLength(text, 'utf8') > MAX_READ_BYTES && !args.offset && !args.limit) {
    return `${numbered}\n\n[file exceeds ${MAX_READ_BYTES} bytes; use offset and limit to page through it]`;
  }
  return numbered;
}

function listDirTool(args, session) {
  const dir = target(args.path || '.', session);
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) throw new Error('path is not a directory');
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !SKIP_DIRS.has(e.name))
    // Muse sees only entries it could read, so denied names never appear.
    .filter((e) => session.profile !== 'muse' || decide({ tool: 'read_file', args: { path: path.join(dir, e.name) } }, session).decision === 'allow')
    .slice(0, MAX_LIST_ENTRIES)
    .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`);
  return entries.join('\n');
}

// Minimal glob: supports *, ?, ** across path segments. No dependency; plain
// Node walk with a small pattern-to-regex translator.
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        // consume an optional following slash so **/x also matches x itself
        if (pattern[i + 1] === '/') i++;
        re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$()[]{}|\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

// decide() only checks the root of a walk, so every entry is re-decided: an
// entry passes if allowed, or if it hits the same ask Russ already approved
// for the root. A grep from Management into Personal stops at Personal.
function walk(dir, baseAbs, out, limit, session, rootDecision) {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
    const abs = path.join(dir, entry.name);
    const d = decide({ tool: 'read_file', args: { path: abs } }, session);
    if (d.decision !== 'allow' && !(d.decision === rootDecision.decision && d.reason === rootDecision.reason)) continue;
    if (entry.isDirectory()) {
      walk(abs, baseAbs, out, limit, session, rootDecision);
    } else {
      out.push(path.relative(baseAbs, abs).replaceAll('\\', '/'));
    }
  }
}

function walkFrom(base, session, out) {
  const rootDecision = decide({ tool: 'read_file', args: { path: base } }, session);
  if (rootDecision.decision !== 'deny') walk(base, base, out, 20000, session, rootDecision);
}

function globTool(args, session) {
  const pattern = String(args.pattern || '');
  if (!pattern) throw new Error('pattern is required');
  const base = target(args.path || '.', session);
  const stat = fs.statSync(base);
  if (!stat.isDirectory()) throw new Error('path is not a directory');
  const all = [];
  walkFrom(base, session, all);
  const re = globToRegExp(pattern);
  const matches = all.filter((rel) => re.test(rel)).slice(0, MAX_GLOB_RESULTS);
  return matches.join('\n');
}

function grepTool(args, session) {
  const needle = String(args.pattern || '');
  if (!needle) throw new Error('pattern is required');
  const muse = session?.profile === 'muse';
  const base = target(args.path || '.', session);
  const stat = fs.statSync(base);
  const flags = args.ignoreCase ? 'i' : '';
  let re;
  try {
    const pattern = muse ? needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : needle;
    re = new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`invalid pattern: ${error.message}`);
  }
  const files = [];
  if (stat.isFile()) {
    files.push(base);
  } else {
    walkFrom(base, session, files);
    for (let i = 0; i < files.length; i++) files[i] = path.join(base, files[i]);
  }
  const matches = [];
  for (const file of files) {
    if (matches.length >= MAX_GREP_MATCHES) break;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(base, file).replaceAll('\\', '/') || path.basename(file);
    const lines = text.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_GREP_MATCHES) break;
      // A Muse match on a guarded line is dropped, not withheld, so grep can't probe its text.
      if (re.test(lines[i]) && !(muse && isGuarded(lines[i], session))) matches.push(`${rel}:${i + 1}:${lines[i]}`);
    }
  }
  return matches.join('\n');
}

function writeFileTool(args, session) {
  const absPath = target(args.path, session);
  const oldText = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : null;
  let content = String(args.content ?? '');
  if (oldText !== null && oldText.includes('\r\n')) {
    content = content.replace(/\r?\n/g, '\r\n');
  }
  return { absPath, oldText, newText: content };
}

function editFileTool(args, session) {
  const absPath = target(args.path, session);
  if (!fs.existsSync(absPath)) throw new Error('file does not exist');
  const oldText = fs.readFileSync(absPath, 'utf8');
  let oldString = String(args.old_string ?? '');
  let newString = String(args.new_string ?? '');
  if (oldText.includes('\r\n')) {
    oldString = oldString.replace(/\r?\n/g, '\r\n');
    newString = newString.replace(/\r?\n/g, '\r\n');
  }
  if (!oldString) throw new Error('old_string is required');
  const count = oldText.split(oldString).length - 1;
  if (count === 0) throw new Error('old_string not found');
  if (count > 1 && !args.replace_all) {
    throw new Error(`old_string matches ${count} times; add context or set replace_all`);
  }
  // A replacer function keeps $& and friends in new_string literal.
  const newText = args.replace_all ? oldText.split(oldString).join(newString) : oldText.replace(oldString, () => newString);
  return { absPath, oldText, newText };
}

// Async (no spawnSync) so a long command never stalls the host's other requests.
function execFileText(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function runCommandTool(args, session) {
  const command = String(args.command ?? '');
  if (!command) throw new Error('command is required');
  const { error, stdout, stderr } = await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: projectRoot(session.project),
    timeout: 120000,
  });
  if (error?.killed) throw new Error('timed out after 120s');
  if (error && typeof error.code !== 'number') throw error;
  let text = `exit ${error ? error.code : 0}\n${stdout}`;
  if (stderr) text += `\n[stderr]\n${stderr}`;
  return text.slice(0, 20000);
}

const HANDLERS = {
  read_file: readFileTool,
  list_dir: listDirTool,
  glob: globTool,
  grep: grepTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  run_command: runCommandTool,
  list_skills: listSkillsTool,
  load_skill: loadSkillTool,
  git_status: gitStatusTool,
  git_diff: gitDiffTool,
  git_commit: gitCommitTool,
};

// Line-based LCS diff. oldText null means empty.
export function unifiedDiff(oldText, newText, label) {
  const oldLines = oldText === null ? [] : oldText.split(/\r\n|\r|\n/);
  const newLines = newText.split(/\r\n|\r|\n/);
  if (oldLines.join('\n') === newLines.join('\n')) return '';
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) return `file replaced: ${n} lines -> ${m} lines`;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push([' ', oldLines[i]]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push(['-', oldLines[i]]);
      i++;
    } else {
      ops.push(['+', newLines[j]]);
      j++;
    }
  }
  while (i < n) {
    ops.push(['-', oldLines[i]]);
    i++;
  }
  while (j < m) {
    ops.push(['+', newLines[j]]);
    j++;
  }
  const hunks = [];
  let start = 0;
  while (start < ops.length) {
    let first = start;
    while (first < ops.length && ops[first][0] === ' ') first++;
    if (first === ops.length) break;
    // Extend through later changes separated by 6 or fewer context lines.
    let last = first;
    for (let k = first + 1; k < ops.length && k - last <= 7; k++) {
      if (ops[k][0] !== ' ') last = k;
    }
    const hunkStart = Math.max(start, first - 3);
    const hunkEnd = Math.min(ops.length, last + 4);
    let oldStart = 0;
    let newStart = 0;
    for (let k = 0; k < hunkStart; k++) {
      if (ops[k][0] !== '+') oldStart++;
      if (ops[k][0] !== '-') newStart++;
    }
    let oldCount = 0;
    let newCount = 0;
    for (let k = hunkStart; k < hunkEnd; k++) {
      if (ops[k][0] !== '+') oldCount++;
      if (ops[k][0] !== '-') newCount++;
    }
    // Unified diff convention: an empty range names the line before it (-0,0 for a new file).
    hunks.push(`@@ -${oldCount ? oldStart + 1 : oldStart},${oldCount} +${newCount ? newStart + 1 : newStart},${newCount} @@`);
    for (let k = hunkStart; k < hunkEnd; k++) {
      hunks.push(`${ops[k][0]}${ops[k][1]}`);
    }
    start = hunkEnd;
  }
  return [`--- a/${label}`, `+++ b/${label}`, ...hunks].join('\n');
}

function relPath(absPath, session) {
  return path.relative(projectRoot(session.project), absPath).replaceAll('\\', '/');
}

function applyWrite(plan, session) {
  const { absPath, oldText, newText } = plan;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  if (session?.profile === 'muse') {
    fs.writeFileSync(absPath, newText, { encoding: 'utf8', flag: 'wx' });
  } else {
    fs.writeFileSync(absPath, newText, 'utf8');
  }
  const rel = relPath(absPath, session);
  const diff = unifiedDiff(oldText, newText, rel);
  // Count from the diff body; the oversize fallback counts whole files.
  const body = diff.startsWith('--- ') ? diff.split('\n').slice(2) : null;
  const lineCount = (text) => (text ? text.split(/\r\n|\r|\n/).length : 0);
  const added = body ? body.filter((l) => l[0] === '+').length : diff ? lineCount(newText) : 0;
  const removed = body ? body.filter((l) => l[0] === '-').length : diff ? lineCount(oldText) : 0;
  const result = `${oldText === null ? 'created' : 'updated'} ${rel}: +${added} -${removed} lines`;
  return { result, diff };
}

// Returns { ok, result, diff? } or { ok: false, error }. Never throws.
async function runToolInner(tool, args, session, { approve, liveCheck, policyOptions } = {}) {
  const call = { tool, args: args || {} };
  const decision = decide(call, session, policyOptions);
  if (decision.decision === 'deny') {
    return { ok: false, error: `denied: ${decision.reason}` };
  }
  if (decision.decision === 'ask') {
    if (session?.profile === 'muse') {
      return { ok: false, error: `denied: ${decision.reason}` };
    }
    if (!approve) {
      return { ok: false, error: `needs approval: ${decision.reason}` };
    }
    let preview;
    if (tool === 'write_file' || tool === 'edit_file') {
      try {
        const plan = tool === 'write_file' ? writeFileTool(call.args, session) : editFileTool(call.args, session);
        preview = unifiedDiff(plan.oldText, plan.newText, relPath(plan.absPath, session));
      } catch {
        preview = undefined;
      }
    } else if (tool === 'run_command') {
      preview = call.args.command;
    } else if (tool === 'git_commit') {
      preview = `${call.args.message}\n\nFiles:\n${call.args.paths.join('\n')}`;
    }
    const approved = await Promise.resolve(approve({ reason: decision.reason, preview, target: typeof call.args.path === 'string' ? resolveTargetPath(call.args.path, session)?.realPath : undefined })).catch(() => false);
    if (!approved) {
      return { ok: false, error: 'denied by the user' };
    }
  }
  const handler = HANDLERS[tool];
  if (!handler) {
    return { ok: false, error: `tool not implemented yet: ${tool}` };
  }
  try {
    if (tool === 'write_file' || tool === 'edit_file') {
      const plan = await handler(call.args, session);
      if (liveCheck && !liveCheck()) return { ok: false, error: 'this request expired before the write; nothing was written' };
      const { result, diff } = applyWrite(plan, session);
      return { ok: true, result, diff };
    }
    return { ok: true, result: await handler(call.args, session) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function scrubMuse(text, session) {
  let value = String(text);
  const root = projectRoot(session.project);
  if (root) {
    value = value.split(root).join('<project>');
    value = value.split(root.replaceAll('\\', '/')).join('<project>');
  }
  return redactGuarded(value, session);
}

// Each Muse turn is an object with a deadline and a step count. A tool call captures it when admitted and
// must still find that same live object before an async write lands, so a draft finishing after a
// timeout or after a newer turn began cannot write.
const museTurns = new Map();
export function museMaxSteps() {
  return Number(process.env.KEELVANE_MUSE_MAX_STEPS) || 30;
}
export function beginMuseTurn(sessionId, ms) {
  museTurns.set(sessionId, { steps: 0, deadline: Date.now() + ms });
}
export function endMuseTurn(sessionId) {
  museTurns.delete(sessionId);
}
function museTurnLive(sessionId, turn) {
  return Boolean(turn) && museTurns.get(sessionId) === turn && Date.now() <= turn.deadline;
}

// Returns { ok, result, diff? } or { ok: false, error }. Never throws.
export async function runTool(tool, args, session, { approve, policyOptions } = {}) {
  let turn;
  if (session?.profile === 'muse') {
    turn = museTurns.get(session.id);
    if (!museTurnLive(session.id, turn)) return { ok: false, error: 'this request has expired' };
    turn.steps += 1;
    if (turn.steps > museMaxSteps()) {
      return { ok: false, error: 'step limit reached for this request; stop and answer with what you have' };
    }
  }
  const outcome = await runToolInner(tool, args, session, { approve, policyOptions,
    liveCheck: turn ? () => museTurnLive(session.id, turn) : null });
  if (session?.profile !== 'muse') {
    return outcome;
  }
  const scrubbed = { ...outcome };
  if (typeof scrubbed.result === 'string') {
    scrubbed.result = scrubMuse(scrubbed.result, session);
  }
  if (typeof scrubbed.error === 'string') {
    scrubbed.error = scrubMuse(scrubbed.error, session);
  }
  return scrubbed;
}
