import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { projectRoot, resolveTargetPath, isCredentialPath, isProtectedWritePath, isInside } from './policy.mjs';

async function git(repoRoot, args, okCodes = [0]) {
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      execFile('git', ['-c', 'core.quotepath=off', '--literal-pathspecs', ...args], {
        cwd: repoRoot,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60000
      }, (error, stdout, stderr) => {
        if (error) {
          // Spawn failures and timeouts have no numeric exit code; never let them pass as exit 1.
          if (typeof error.code !== 'number') reject(error);
          else resolve({ code: error.code, stdout, stderr });
        } else {
          resolve({ code: 0, stdout, stderr });
        }
      });
    });
  } catch (error) {
    throw new Error(`git ${args[0]} failed: ${(error.message || '').trim().slice(0, 500)}`);
  }
  if (!okCodes.includes(result.code)) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr || '').trim().slice(0, 500)}`);
  }
  return result;
}

function toRepoRel(repoRoot, abs) {
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

export async function repoRootFor(dir) {
  const { stdout } = await git(dir, ['rev-parse', '--show-toplevel']);
  return path.resolve(stdout.trim());
}

export async function gitStatus({ repoRoot, scopeAbs }) {
  const scope = toRepoRel(repoRoot, scopeAbs);
  const pathspec = scope || '.';

  let branch = null;
  let head = null;
  try {
    const branchResult = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], [0, 128]);
    if (branchResult.code === 0) branch = branchResult.stdout.trim();
  } catch {
    branch = null;
  }
  try {
    const headResult = await git(repoRoot, ['rev-parse', '--short', 'HEAD'], [0, 128]);
    if (headResult.code === 0) head = headResult.stdout.trim();
  } catch {
    head = null;
  }

  const { stdout } = await git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', pathspec]);
  const records = stdout.split('\0').filter(r => r.length > 0);
  const files = [];
  let truncated = false;

  for (let i = 0; i < records.length; i++) {
    if (files.length >= 500) {
      truncated = true;
      break;
    }
    const record = records[i];
    if (record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    const filePath = record.slice(3);
    let orig = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i++;
      if (i < records.length) orig = records[i];
    }
    const xy = x + y;
    let label;
    if (xy === '??') {
      label = 'untracked';
    } else if (xy.includes('U') || xy === 'AA' || xy === 'DD') {
      label = 'conflicted';
    } else if (x === 'R' || y === 'R') {
      label = 'renamed';
    } else if (x === 'D' || y === 'D') {
      label = 'deleted';
    } else if (x === 'A') {
      label = 'added';
    } else {
      label = 'modified';
    }
    files.push({
      path: filePath,
      orig,
      index: xy === '??' ? '?' : x,
      worktree: xy === '??' ? '?' : y,
      label
    });
  }

  return { branch, head, scope, files, truncated };
}

export async function gitDiff({ repoRoot, scopeAbs, path: relPath }) {
  const scope = toRepoRel(repoRoot, scopeAbs);
  const pathspec = scope || '.';

  if (!relPath) {
    const status = await gitStatus({ repoRoot, scopeAbs });
    const { stdout } = await git(repoRoot, ['diff', 'HEAD', '--stat', '--', pathspec]);
    let text = stdout.trimEnd();
    const untracked = status.files.filter(f => f.label === 'untracked').map(f => f.path);
    if (untracked.length > 0) {
      if (text) text += '\n';
      text += 'Untracked files:\n';
      text += untracked.slice(0, 100).map(p => `  ${p}`).join('\n');
      if (untracked.length > 100) text += `\n  ... and ${untracked.length - 100} more`;
    }
    if (!text.trim()) return 'No changes.';
    return text;
  }

  if (typeof relPath !== 'string' || relPath.includes('\0') || path.isAbsolute(relPath)) {
    const err = new Error('bad path');
    err.status = 400;
    throw err;
  }
  const normalized = path.posix.normalize(relPath);
  if (normalized.startsWith('..')) {
    const err = new Error('bad path');
    err.status = 400;
    throw err;
  }
  const abs = path.resolve(repoRoot, relPath);
  if (!isInside(scopeAbs, abs)) {
    const err = new Error("path is outside this session's project");
    err.status = 400;
    throw err;
  }
  if (isCredentialPath(abs)) {
    const err = new Error('credential or secret paths are never shown');
    err.status = 400;
    throw err;
  }

  const status = await gitStatus({ repoRoot, scopeAbs });
  const entry = status.files.find(f => f.path.toLowerCase() === relPath.toLowerCase());
  // Only a single changed file: a directory pathspec could pull in credential files beneath it.
  if (!entry) {
    const err = new Error(`not a changed file in this project: ${relPath}`);
    err.status = 400;
    throw err;
  }
  if (entry.orig && isCredentialPath(path.resolve(repoRoot, entry.orig))) {
    const err = new Error('credential or secret paths are never shown');
    err.status = 400;
    throw err;
  }
  let result;
  if (entry.label === 'untracked') {
    result = await git(repoRoot, ['diff', '--no-index', '--', '/dev/null', entry.path], [0, 1]);
  } else {
    const pathspecs = [entry.path];
    if (entry.orig) pathspecs.push(entry.orig);
    result = await git(repoRoot, ['diff', 'HEAD', '--', ...pathspecs]);
  }
  let text = result.stdout;
  if (!text.trim()) return 'No changes.';
  if (text.length > 200000) {
    text = text.slice(0, 200000) + '\n[diff truncated]';
  }
  return text;
}

export async function gitCommit({ repoRoot, scopeAbs, paths, message }) {
  if (typeof message !== 'string' || !message.trim() || message.length > 5000) {
    const err = new Error('message must be a non-empty string of at most 5000 characters');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 200) {
    const err = new Error('paths must be a non-empty array of at most 200 strings');
    err.status = 400;
    throw err;
  }

  const status = await gitStatus({ repoRoot, scopeAbs });
  const pathspecs = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p.includes('\0') || path.isAbsolute(p)) {
      const err = new Error('bad path');
      err.status = 400;
      throw err;
    }
    const normalized = path.posix.normalize(p);
    if (normalized.startsWith('..')) {
      const err = new Error('bad path');
      err.status = 400;
      throw err;
    }
    const abs = path.resolve(repoRoot, p);
    if (!isInside(scopeAbs, abs)) {
      const err = new Error("path is outside this session's project");
      err.status = 400;
      throw err;
    }
    if (isCredentialPath(abs)) {
      const err = new Error('credential or secret paths are never shown');
      err.status = 400;
      throw err;
    }
    if (isProtectedWritePath(abs, scopeAbs)) {
      const err = new Error(`protected path cannot be committed through Keelvane: ${p}`);
      err.status = 400;
      throw err;
    }
    const entry = status.files.find(f => f.path.toLowerCase() === p.toLowerCase());
    if (!entry) {
      const err = new Error(`not a changed file in this project: ${p}`);
      err.status = 400;
      throw err;
    }
    pathspecs.push(entry.path);
    if (entry.orig) {
      const origAbs = path.resolve(repoRoot, entry.orig);
      if (!isInside(scopeAbs, origAbs) || isCredentialPath(origAbs) || isProtectedWritePath(origAbs, scopeAbs)) {
        const err = new Error(`rename source cannot be committed through Keelvane: ${entry.orig}`);
        err.status = 400;
        throw err;
      }
      pathspecs.push(entry.orig);
    }
  }

  const unique = [...new Set(pathspecs)];
  await git(repoRoot, ['add', '-A', '--', ...unique]);
  await git(repoRoot, ['commit', '-m', message, '--', ...unique]);
  const { stdout } = await git(repoRoot, ['rev-parse', '--short', 'HEAD']);
  return { hash: stdout.trim(), subject: message.trim().split(/\r?\n/)[0] };
}

export function formatStatus(status, { repoRoot, scopeAbs }) {
  const lines = [`branch ${status.branch || '(none)'} @ ${status.head || '(no commits)'}`];
  const prefix = status.scope ? status.scope + '/' : '';
  for (const f of status.files) {
    const rel = f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path;
    const label = f.label.padEnd(10);
    if (f.orig) {
      const origRel = f.orig.startsWith(prefix) ? f.orig.slice(prefix.length) : f.orig;
      lines.push(`${label} ${origRel} -> ${rel}`);
    } else {
      lines.push(`${label} ${rel}`);
    }
  }
  if (status.files.length === 0) lines.push('Working tree clean for this project.');
  if (status.truncated) lines.push('[showing first 500 changes]');
  return lines.join('\n');
}

async function sessionScope(session) {
  const scopeAbs = projectRoot(session.project);
  if (!scopeAbs) throw new Error(`unknown project: ${session.project}`);
  const repoRoot = await repoRootFor(scopeAbs);
  return { scopeAbs, repoRoot };
}

function toScopedRepoRel(p, session, repoRoot) {
  const t = resolveTargetPath(p, session);
  if (!t) throw new Error(`cannot resolve path: ${p}`);
  return toRepoRel(repoRoot, t.absPath);
}

export async function gitStatusTool(args, session) {
  const { scopeAbs, repoRoot } = await sessionScope(session);
  const status = await gitStatus({ repoRoot, scopeAbs });
  return formatStatus(status, { repoRoot, scopeAbs });
}

export async function gitDiffTool(args, session) {
  const { scopeAbs, repoRoot } = await sessionScope(session);
  let relPath;
  if (typeof args.path === 'string' && args.path.length > 0) {
    relPath = toScopedRepoRel(args.path, session, repoRoot);
  }
  return gitDiff({ repoRoot, scopeAbs, path: relPath });
}

export async function gitCommitTool(args, session) {
  const { scopeAbs, repoRoot } = await sessionScope(session);
  if (!Array.isArray(args.paths)) throw new Error('paths must be an array');
  const paths = args.paths.map(p => toScopedRepoRel(p, session, repoRoot));
  const result = await gitCommit({ repoRoot, scopeAbs, paths, message: args.message });
  return `committed ${result.hash}: ${result.subject} (${paths.length} path(s))`;
}
