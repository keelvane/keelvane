import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.mjs';

export const MUSE_MAX_LINES = 40;

export function museFilenameError(basename) {
  if (typeof basename !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(basename)) {
    return 'file name must use 1 to 80 ASCII letters, numbers, dots, underscores or hyphens';
  }
  if (!/\.(?:md|txt)$/i.test(basename)) {
    return 'Muse may only write .md or .txt files';
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename)) {
    return 'this file name is reserved on Windows';
  }
  return null;
}

export function museContentError(content) {
  if (typeof content !== 'string') return 'file content must be a string';
  const lines = content.split(/\r\n|\r|\n/);
  const lineCount = lines.length - (content === '' || /(?:\r\n|\r|\n)$/.test(content) ? 1 : 0);
  return lineCount > MUSE_MAX_LINES ? `file content exceeds ${MUSE_MAX_LINES} lines` : null;
}

// ---- Projects (from config) ----------------------------------------------

export function dataDir() {
  return getConfig().dataDir;
}

export function listProjects() {
  return getConfig().projects;
}

export function getProject(code) {
  return getConfig().projects.find((p) => p.code === code) || null;
}

export function projectRoot(code) {
  const project = getProject(code);
  return project ? path.resolve(project.path) : null;
}

// A project is open to Muse only when its config carries a `muse` block.
export function museConfig(code) {
  return getProject(code)?.muse || null;
}

export function museProjectCodes() {
  return getConfig().projects.filter((p) => p.muse).map((p) => p.code);
}

export const MUSE_DEFAULT_INBOX = 'Muse-Inbox';

function withholdRes(session) {
  return (museConfig(session?.project)?.withhold || []).map((re) => new RegExp(re, 'i'));
}

export function isGuarded(text, session) {
  const value = String(text);
  return withholdRes(session).some((re) => re.test(value));
}

export function redactGuarded(text, session) {
  return String(text)
    .split(/\r\n|\r|\n/)
    .map((line) => (isGuarded(line, session) ? '[line withheld]' : line))
    .join('\n');
}

// Uploads for one session; its reads are allowed even though dataDir is outside the project.
export function attachmentsDir(sessionId, dir = dataDir()) {
  return path.join(dir, 'attachments', sessionId);
}

// Checked before any filesystem call: a UNC path would contact the host, and
// NTFS streams or 8.3 short names spell a protected file another way.
export function unsafePathReason(rawPath) {
  if (/^[\\/]{2}/.test(rawPath)) return 'network and device paths are not allowed';
  if (rawPath.replace(/^[a-z]:(?=[\\/])/i, '').includes(':')) return 'stream names and drive-relative paths are not allowed';
  if (/(?:^|[\\/])[^\\/]*~\d/.test(rawPath)) return '8.3 short names are not allowed';
  // Windows strips a trailing dot or space, so Codex writing AGENTS.md. lands on AGENTS.md.
  if (rawPath.split(/[\\/]/).some((s) => s !== '.' && s !== '..' && /[. ]$/.test(s))) {
    return 'path segments ending in a dot or space are not allowed';
  }
  return null;
}

// Scripts and executables run later, outside approval. HTML counts: a local page can carry inline scripts.
const EXEC_RE = /(?:\.(?:m?js|cjs|ts|html?|ps1|psm1|py|pyw|vbs|vbe|wsf|hta|bat|cmd|exe|dll|lnk|sh|reg|scr|msi)|[\\/]package\.json)$/i;

function resolveReal(absPath) {
  try {
    // .native expands 8.3 short names; the JS version keeps them as typed.
    return fs.realpathSync.native(absPath);
  } catch {
    const parent = path.dirname(absPath);
    if (parent === absPath) {
      return absPath;
    }
    const realParent = resolveReal(parent);
    return path.join(realParent, path.basename(absPath));
  }
}

// Shared by tools.mjs so the executor resolves paths identically to decide().
export function resolveTargetPath(rawPath, session) {
  const root = projectRoot(session.project);
  if (root === null) return null;
  const absPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, rawPath);
  return { root, absPath, realPath: resolveReal(absPath) };
}

export function isInside(root, target) {
  const rootLower = root.toLowerCase();
  const targetLower = target.toLowerCase();
  const rel = path.relative(rootLower, targetLower);
  if (rel === '') {
    return true;
  }
  if (path.isAbsolute(rel)) {
    return false;
  }
  return !rel.startsWith('..');
}

export function isCredentialPath(absPath) {
  const realPath = resolveReal(absPath);
  const candidates = [absPath, realPath];

  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, '/').toLowerCase();
    const basename = path.basename(candidate);
    const basenameLower = basename.toLowerCase();

    if (/\.env(?:\..*)?$/.test(basenameLower)) {
      return true;
    }

    if (/\.(pem|key|pfx|p12)$/.test(basenameLower)) {
      return true;
    }

    // Key files named like api-key or deploy.key.
    if (/(?:^|[._-])key$/.test(basenameLower)) {
      return true;
    }

    if (normalized.includes('/.ssh/')) {
      return true;
    }

    if (normalized.endsWith('/.claude/.credentials.json')) {
      return true;
    }

    if (normalized.endsWith('/.codex/auth.json')) {
      return true;
    }

    if (/(credential|secret|token|password)/.test(basenameLower)) {
      return true;
    }
  }

  return false;
}

// A tiny glob: ** crosses folders, * and ? stay inside one path segment. Matching is case-insensitive.
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i += 1;
      if (glob[i + 1] === '/') {
        i += 1;
        out += '(?:.*/)?';
      } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += /[a-z0-9_\/ -]/i.test(c) ? c : '\\' + c;
  }
  return new RegExp(`^${out}$`, 'i');
}

export function isProtectedWritePath(absPath, root) {
  const rel = path.relative(root, absPath).replace(/\\/g, '/');
  const base = path.basename(absPath).toLowerCase();

  // Instruction files steer the engines on their next start; owners edit them directly.
  if (base === 'agents.md' || base === 'claude.md') {
    return true;
  }

  if (
    /(?:credential|secret|token|password)/i.test(base) ||
    /\.(pem|pfx|p12|key)$/i.test(base) ||
    /private\.key$/i.test(base)
  ) {
    return true;
  }

  // Engine config, hooks and instruction files load on the next engine start.
  const segments = rel.toLowerCase().split('/');
  if (segments.some((s) => ['.git', '.claude', '.codex', '.agents'].includes(s))) {
    return true;
  }
  if (['.mcp.json', '.claude.json', 'claude.local.md', 'agents.override.md'].includes(base)) {
    return true;
  }
  return getConfig().protectedGlobs.some((g) => globToRegExp(g).test(rel));
}

function hasSymlinkAncestor(root, absPath) {
  const rel = path.relative(root, absPath);
  if (rel === '' || path.isAbsolute(rel) || rel.startsWith('..')) {
    return false;
  }

  const segments = rel.split(path.sep);
  let ancestor = root;

  for (const segment of segments) {
    ancestor = path.join(ancestor, segment);
    if (fs.existsSync(ancestor)) {
      try {
        if (fs.lstatSync(ancestor).isSymbolicLink()) {
          return true;
        }
      } catch {
        // Ignore lstat errors and continue walking.
      }
    }
  }

  return false;
}

export function countAddedLines(tool, args) {
  if (tool === 'write_file') {
    if (typeof args.content !== 'string') {
      return 0;
    }
    return args.content.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '').length;
  }

  if (tool === 'edit_file') {
    if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
      return 0;
    }
    const oldLines = args.old_string.split(/\r\n|\r|\n/).map((line) => line.trim());
    return args.new_string
      .split(/\r\n|\r|\n/)
      .filter((line) => line.trim() !== '' && !oldLines.includes(line.trim())).length;
  }

  return 0;
}

function decideMuse(call, session, opts = {}) {
  const tool = call && call.tool;
  const muse = museConfig(session.project);

  if (session.engine !== 'claude') {
    return { decision: 'deny', reason: 'Muse sessions must use the Claude engine' };
  }

  if (!muse) {
    return { decision: 'deny', reason: 'this project is not available to Muse' };
  }

  const readTools = ['read_file', 'list_dir', 'glob', 'grep'];
  const writeTools = ['write_file'];
  if (!readTools.includes(tool) && !writeTools.includes(tool)) {
    return { decision: 'deny', reason: 'this tool is not available to Muse' };
  }

  const args = call.args || {};
  const hasPath = typeof args.path === 'string' && args.path.trim() !== '';
  const pathOptionalTools = ['list_dir', 'glob', 'grep'];
  const rawPath = hasPath ? args.path : (pathOptionalTools.includes(tool) ? '.' : undefined);
  if (rawPath === undefined) {
    return { decision: 'deny', reason: 'path is required' };
  }

  const unsafe = unsafePathReason(rawPath);
  if (unsafe) {
    return { decision: 'deny', reason: unsafe };
  }

  const root = projectRoot(session.project);
  if (root === null) {
    return { decision: 'deny', reason: `unknown project: ${session.project}` };
  }

  const absPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, rawPath);
  const realPath = resolveReal(absPath);

  if (!isInside(root, absPath) || !isInside(resolveReal(root), realPath)) {
    return { decision: 'deny', reason: 'path is outside the session project' };
  }

  if (hasSymlinkAncestor(root, absPath)) {
    return { decision: 'deny', reason: 'symlinks are not allowed' };
  }

  if (isCredentialPath(absPath) || isCredentialPath(realPath)) {
    return { decision: 'deny', reason: 'credential or secret paths are never accessible' };
  }

  // Check the path as typed and as it sits on disk, so a lowercase spelling cannot pass the case-sensitive guard.
  // The project's withhold patterns keep named material out of Muse's sight even where the allowlist is wide.
  for (const rel of [path.relative(root, absPath), path.relative(resolveReal(root), realPath)].map((p) => p.replace(/\\/g, '/'))) {
    const segments = rel.toLowerCase().split('/');
    if (segments.includes('.git')) {
      return { decision: 'deny', reason: 'this folder is not available to Muse' };
    }
    if (isGuarded(rel, session)) {
      return { decision: 'deny', reason: 'this path is not available to Muse' };
    }
  }

  if (readTools.includes(tool)) {
    // Curated allowlist: only the project's muse.read files (plus inbox drafts) are readable.
    const readFiles = muse.read.map((f) => f.replace(/\\/g, '/').toLowerCase());
    const readDirs = new Set();
    for (const f of readFiles) {
      const parts = f.split('/');
      for (let n = 1; n < parts.length; n++) readDirs.add(parts.slice(0, n).join('/'));
    }
    const inboxLower = muse.inbox.toLowerCase();
    readDirs.add(inboxLower);
    const relAllowed = (p) => {
      const rel = p.replace(/\\/g, '/').toLowerCase();
      if (rel === '' || readDirs.has(rel) || readFiles.includes(rel)) return true;
      const parts = rel.split('/');
      return parts.length === 2 && parts[0] === inboxLower && /\.(md|txt)$/.test(parts[1]);
    };
    if (!relAllowed(path.relative(root, absPath)) || !relAllowed(path.relative(resolveReal(root), realPath))) {
      return { decision: 'deny', reason: 'this file is not on the Muse allowlist' };
    }
    // A hardlink keeps an in-project real path but can point at a file stored outside the project.
    try {
      const st = fs.statSync(realPath, { throwIfNoEntry: false });
      if (st && st.isFile() && st.nlink > 1) {
        return { decision: 'deny', reason: 'multiply linked files are not allowed' };
      }
    } catch {
      return { decision: 'deny', reason: 'file could not be checked' };
    }
    if (tool === 'grep') {
      if (typeof args.pattern !== 'string' || args.pattern.length < 1 || args.pattern.length > 200) {
        return { decision: 'deny', reason: 'grep pattern must be 1 to 200 characters' };
      }
      if (isGuarded(args.pattern, session)) {
        return { decision: 'deny', reason: 'this pattern is not available to Muse' };
      }
    }
    if (tool === 'glob') {
      if (typeof args.pattern !== 'string' || args.pattern.length < 1 || args.pattern.length > 120) {
        return { decision: 'deny', reason: 'glob pattern must be 1 to 120 characters' };
      }
      if ((args.pattern.match(/\*/g) || []).length > 4) {
        return { decision: 'deny', reason: 'glob pattern may contain at most 4 asterisks' };
      }
      if (isGuarded(args.pattern, session)) {
        return { decision: 'deny', reason: 'this pattern is not available to Muse' };
      }
    }
    return { decision: 'allow', reason: 'read tool targets a path inside the session project' };
  }

  const inbox = path.join(root, muse.inbox);
  const realInbox = path.join(resolveReal(root), muse.inbox);
  if (
    path.dirname(absPath).toLowerCase() !== inbox.toLowerCase() ||
    path.dirname(realPath).toLowerCase() !== realInbox.toLowerCase()
  ) {
    return { decision: 'deny', reason: `Muse may only write inside the ${muse.inbox} folder` };
  }

  const basename = path.basename(absPath);
  const filenameError = museFilenameError(basename);
  if (filenameError) return { decision: 'deny', reason: filenameError };

  try {
    if (fs.lstatSync(absPath, { throwIfNoEntry: false })) {
      return { decision: 'deny', reason: 'the target file already exists' };
    }
  } catch {
    return { decision: 'deny', reason: 'the target file already exists' };
  }

  if (isProtectedWritePath(absPath, root)) {
    return { decision: 'deny', reason: 'protected path cannot be written through Keelvane' };
  }

  if (tool === 'write_file') {
    const contentError = museContentError(args.content);
    if (contentError) return { decision: 'deny', reason: contentError };
  }

  return { decision: 'allow', reason: 'write tool targets a non-protected path inside the Muse inbox folder' };
}

export function decide(call, session, opts = {}) {
  if (session?.profile === 'muse') return decideMuse(call, session, opts);
  const tool = call && call.tool;

  const knownTools = [
    'read_file',
    'list_dir',
    'glob',
    'grep',
    'edit_file',
    'write_file',
    'run_command',
    'git_status',
    'git_diff',
    'git_commit',
    'list_skills',
    'load_skill',
    'web_fetch'
  ];

  if (!knownTools.includes(tool)) {
    return { decision: 'deny', reason: `unknown tool: ${tool}` };
  }

  const pathTools = ['read_file', 'list_dir', 'glob', 'grep', 'edit_file', 'write_file'];
  // list_dir/glob/grep accept an omitted path and default to the project root,
  // matching their optional MCP schema field and tools.mjs's own fallback.
  const pathOptionalTools = ['list_dir', 'glob', 'grep'];

  if (pathTools.includes(tool)) {
    const args = call.args || {};
    const hasPath = typeof args.path === 'string' && args.path.trim() !== '';
    const rawPath = hasPath ? args.path : (pathOptionalTools.includes(tool) ? '.' : undefined);

    if (rawPath === undefined) {
      return { decision: 'deny', reason: 'path is required' };
    }
    const unsafe = unsafePathReason(rawPath);
    if (unsafe) {
      return { decision: 'deny', reason: unsafe };
    }

    const root = projectRoot(session.project);
    if (root === null) {
      return { decision: 'deny', reason: `unknown project: ${session.project}` };
    }
    const realRoot = resolveReal(root);

    const absPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(root, rawPath);
    const realPath = resolveReal(absPath);

    if (isCredentialPath(absPath) || isCredentialPath(realPath)) {
      return { decision: 'deny', reason: 'credential or secret paths are never accessible' };
    }

    const readTools = ['read_file', 'list_dir', 'glob', 'grep'];
    if (readTools.includes(tool)) {
      if (session.id && isInside(attachmentsDir(session.id, opts.dataDir), realPath)) {
        return { decision: 'allow', reason: 'reading a file the user attached to this session' };
      }
      if (!isInside(realRoot, realPath)) {
        return { decision: 'ask', reason: 'path is outside the session project' };
      }
      return { decision: 'allow', reason: 'read tool targets a path inside the session project' };
    }

    if (
      isProtectedWritePath(realPath, realRoot) ||
      hasSymlinkAncestor(root, absPath) ||
      hasSymlinkAncestor(realRoot, realPath)
    ) {
      return { decision: 'deny', reason: 'protected path or symlink cannot be written through Keelvane' };
    }

    if (!isInside(realRoot, realPath)) {
      return { decision: 'ask', reason: 'write target is outside the session project' };
    }

    if (EXEC_RE.test(realPath)) {
      return { decision: 'ask', reason: 'scripts and executables run outside approval; writing one needs approval' };
    }

    return { decision: 'allow', reason: 'write tool targets a non-protected path inside the session project' };
  }

  if (tool === 'git_commit' || tool === 'git_diff') {
    const args = call.args || {};
    const root = projectRoot(session.project);
    if (root === null) return { decision: 'deny', reason: `unknown project: ${session.project}` };
    const commit = tool === 'git_commit';
    if (commit && (typeof args.message !== 'string' || !args.message.trim())) {
      return { decision: 'deny', reason: 'git_commit needs a non-empty message' };
    }
    if (commit && (!Array.isArray(args.paths) || args.paths.length === 0)) {
      return { decision: 'deny', reason: 'git_commit needs a non-empty paths list' };
    }
    const paths = commit ? args.paths : (typeof args.path === 'string' && args.path.trim() ? [args.path] : []);
    for (const p of paths) {
      if (typeof p !== 'string' || !p.trim()) return { decision: 'deny', reason: 'every path must be a non-empty string' };
      const unsafe = unsafePathReason(p);
      if (unsafe) return { decision: 'deny', reason: unsafe };
      const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
      const real = resolveReal(abs);
      if (isCredentialPath(abs) || isCredentialPath(real)) {
        return { decision: 'deny', reason: 'credential or secret paths are never accessible' };
      }
      if (!isInside(root, real)) return { decision: 'deny', reason: `${p} is outside the session project` };
      if (commit && isProtectedWritePath(real, resolveReal(root))) {
        return { decision: 'deny', reason: `protected path cannot be committed through Keelvane: ${p}` };
      }
    }
    return commit
      ? { decision: 'ask', reason: 'git_commit always requires approval' }
      : { decision: 'allow', reason: 'git_diff inside the session project' };
  }

  if (tool === 'run_command' || tool === 'web_fetch') {
    return { decision: 'ask', reason: `${tool} always requires approval` };
  }

  if (tool === 'git_status' || tool === 'list_skills' || tool === 'load_skill') {
    return { decision: 'allow', reason: `${tool} is always allowed` };
  }

  return { decision: 'deny', reason: 'unreachable' };
}

export function decideFileChanges(changes, session, opts = {}) {
  if (session?.profile === 'muse') return { decision: 'deny', reason: 'Muse sessions cannot apply patches' };
  if (!Array.isArray(changes) || changes.length === 0) {
    return { decision: 'deny', reason: 'empty change set' };
  }

  const severity = { allow: 0, ask: 1, deny: 2 };
  let worst = { decision: 'allow', reason: '' };

  for (const change of changes) {
    if (typeof change?.path !== 'string' || typeof change?.diff !== 'string' || !change?.kind) {
      return { decision: 'deny', reason: 'malformed file change' };
    }
    const basename = path.basename(change.path);
    let result;

    if (change.kind.type === 'add') {
      result = decide({ tool: 'write_file', args: { path: change.path, content: change.diff } }, session, opts);
    } else if (change.kind.type === 'update') {
      const lines = change.diff.split(/\r\n|\r|\n/);
      const oldLines = [];
      const newLines = [];
      for (const line of lines) {
        if (line.startsWith('-')) {
          oldLines.push(line.slice(1));
        } else if (line.startsWith('+')) {
          newLines.push(line.slice(1));
        }
      }
      const old_string = oldLines.join('\n');
      const new_string = newLines.join('\n');
      result = decide({ tool: 'edit_file', args: { path: change.path, old_string, new_string } }, session, opts);

      if (change.kind.move_path) {
        const moveResult = decide({ tool: 'write_file', args: { path: change.kind.move_path, content: '' } }, session, opts);
        if (severity[moveResult.decision] > severity[result.decision]) {
          result = moveResult;
        }
      }
    } else if (change.kind.type === 'delete') {
      result = decide({ tool: 'write_file', args: { path: change.path, content: '' } }, session, opts);
      if (result.decision === 'allow') {
        result = { decision: 'ask', reason: 'deleting a file always requires approval' };
      }
    } else {
      result = { decision: 'deny', reason: 'unknown change kind' };
    }

    if (result.decision !== 'allow') {
      result = { ...result, reason: `${basename}: ${result.reason}` };
    }

    if (severity[result.decision] > severity[worst.decision]) {
      worst = result;
    }
  }

  if (worst.decision === 'allow') {
    worst = { decision: 'allow', reason: 'every change targets a non-protected path inside the session project' };
  }

  return worst;
}
