import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decide, listProjects, projectRoot, countAddedLines, decideFileChanges } from '../policy.mjs';
import { useFixture } from './fixture.mjs';

const fixture = useFixture({ protectedGlobs: ['.git/**', '**/.env', '**/*.pem', 'private/**'] });
after(() => fixture.cleanup());

const alpha = { project: 'alpha' };
const bravo = { project: 'bravo' };
const alphaFile = (rel) => path.join(fixture.alpha, rel);
const bravoFile = (rel) => path.join(fixture.bravo, rel);

test('read_file inside the project is allowed', () => {
  const d = decide({ tool: 'read_file', args: { path: 'project-notes.md' } }, alpha);
  assert.equal(d.decision, 'allow');
});

test('read tools are project scoped: reading another project asks', () => {
  const rel = decide({ tool: 'read_file', args: { path: '../bravo/project-notes.md' } }, alpha);
  const abs = decide({ tool: 'read_file', args: { path: bravoFile('project-notes.md') } }, alpha);
  assert.equal(rel.decision, 'ask');
  assert.equal(abs.decision, 'ask');
  assert.equal(decide({ tool: 'read_file', args: { path: bravoFile('project-notes.md') } }, bravo).decision, 'allow');
});

test('read outside every project asks for approval', () => {
  const outside = path.join(fixture.root, 'outside.txt');
  assert.equal(decide({ tool: 'read_file', args: { path: outside } }, alpha).decision, 'ask');
  const hosts = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  assert.equal(decide({ tool: 'read_file', args: { path: hosts } }, alpha).decision, 'ask');
});

test('write inside the project to a non-protected path is allowed', () => {
  const d = decide({ tool: 'write_file', args: { path: 'scratch-note.md' } }, alpha);
  assert.equal(d.decision, 'allow');
});

test('write outside the session project asks for approval', () => {
  const d = decide({ tool: 'write_file', args: { path: '../bravo/scratch-note.md' } }, alpha);
  assert.equal(d.decision, 'ask');
});

test('write to CLAUDE.md is denied, case-insensitively', () => {
  const lower = decide({ tool: 'write_file', args: { path: 'claude.md' } }, alpha);
  const upper = decide({ tool: 'write_file', args: { path: 'CLAUDE.MD' } }, alpha);
  assert.equal(lower.decision, 'deny');
  assert.equal(upper.decision, 'deny');
});

test('write to AGENTS.md is denied', () => {
  const d = decide({ tool: 'write_file', args: { path: 'AGENTS.md' } }, alpha);
  assert.equal(d.decision, 'deny');
});

test('write into a folder matched by protectedGlobs is denied', () => {
  const d = decide({ tool: 'write_file', args: { path: 'private/budget.md' } }, alpha);
  assert.equal(d.decision, 'deny');
  assert.equal(decide({ tool: 'write_file', args: { path: 'public/budget.md' } }, alpha).decision, 'allow');
});

test('credential-looking filenames are denied for both read and write, taking precedence', () => {
  const r = decide({ tool: 'read_file', args: { path: '.env' } }, alpha);
  const w = decide({ tool: 'write_file', args: { path: 'secrets/api-token.txt' } }, alpha);
  assert.equal(r.decision, 'deny');
  assert.equal(w.decision, 'deny');
});

test('missing path for a path tool is denied', () => {
  const d = decide({ tool: 'read_file', args: {} }, alpha);
  assert.equal(d.decision, 'deny');
});

test('unknown project is denied', () => {
  const d = decide({ tool: 'read_file', args: { path: 'x.md' } }, { project: 'nonexistent' });
  assert.equal(d.decision, 'deny');
});

test('unknown tool is denied', () => {
  const d = decide({ tool: 'delete_everything', args: {} }, alpha);
  assert.equal(d.decision, 'deny');
});

test('run_command, web_fetch, git_commit always ask', () => {
  for (const tool of ['run_command', 'web_fetch', 'git_commit']) {
    // git_commit is denied without paths and a message (policy-m4.test.mjs covers that).
    const args = tool === 'git_commit' ? { paths: ['notes.md'], message: 'm' } : {};
    const d = decide({ tool, args }, alpha);
    assert.equal(d.decision, 'ask', tool);
  }
});

test('git_status, git_diff, list_skills, load_skill are always allowed', () => {
  for (const tool of ['git_status', 'git_diff', 'list_skills', 'load_skill']) {
    const d = decide({ tool, args: {} }, alpha);
    assert.equal(d.decision, 'allow', tool);
  }
});

test('projectRoot resolves every configured project and is null for unknown codes', () => {
  assert.deepEqual(listProjects().map((p) => p.code), ['alpha', 'bravo']);
  for (const p of listProjects()) {
    assert.equal(projectRoot(p.code), path.resolve(p.path), p.code);
  }
  assert.equal(projectRoot('nonexistent'), null);
});

test('symlink ancestor is denied for writes, using a throwaway link inside the fixture', (t) => {
  const real = alphaFile('real');
  const link = alphaFile('link');
  fs.mkdirSync(real, { recursive: true });
  try {
    fs.symlinkSync(real, link, 'junction');
  } catch {
    t.skip('symlink/junction creation not permitted on this machine');
    return;
  }
  try {
    const d = decide({ tool: 'write_file', args: { path: 'link/note.md' } }, alpha);
    assert.equal(d.decision, 'deny');
  } finally {
    fs.rmSync(link, { force: true });
  }
});

test('countAddedLines counts non-blank lines in write_file content', () => {
  const content = 'one\n\ntwo\r\nthree\r\n\r\nfour';
  assert.equal(countAddedLines('write_file', { content }), 4);
});

test('countAddedLines returns 0 for write_file with non-string content', () => {
  assert.equal(countAddedLines('write_file', { content: 42 }), 0);
});

test('countAddedLines counts only new non-blank lines for edit_file', () => {
  const args = {
    old_string: 'alpha\nbeta\n\ngamma',
    new_string: 'alpha\nbeta\n\ngamma\ndelta\n\nepsilon'
  };
  assert.equal(countAddedLines('edit_file', args), 2);
});

test('countAddedLines does not count a line already present in old_string', () => {
  const args = {
    old_string: 'alpha\nbeta',
    new_string: 'alpha\nbeta\nalpha\n\ngamma'
  };
  assert.equal(countAddedLines('edit_file', args), 1);
});

test('countAddedLines returns 0 for edit_file with non-string fields', () => {
  assert.equal(countAddedLines('edit_file', { old_string: 'a', new_string: 5 }), 0);
  assert.equal(countAddedLines('edit_file', { old_string: 5, new_string: 'a' }), 0);
});

test('countAddedLines returns 0 for other tools', () => {
  assert.equal(countAddedLines('read_file', { path: 'x.md' }), 0);
});

test('owner writes have no line cap: 41-line write, edit and patch are allowed', () => {
  const lines = Array.from({ length: 41 }, (_, i) => `line ${i + 1}`);
  const write = decide({ tool: 'write_file', args: { path: 'draft.md', content: lines.join('\n') } }, alpha);
  const edit = decide({ tool: 'edit_file', args: { path: 'draft.md', old_string: 'old', new_string: lines.join('\n') } }, alpha);
  const patch = decideFileChanges([{
    path: alphaFile('draft.md'),
    kind: { type: 'add' },
    diff: Array.from({ length: 50 }, (_, i) => `patch ${i + 1}`).join('\n')
  }], alpha);

  assert.equal(write.decision, 'allow');
  assert.equal(edit.decision, 'allow');
  assert.equal(patch.decision, 'allow');
});

test('decideFileChanges: update inside the project is allow', () => {
  const changes = [{
    path: alphaFile('note.md'),
    kind: { type: 'update', move_path: null },
    diff: '@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n'
  }];
  const d = decideFileChanges(changes, alpha);
  assert.equal(d.decision, 'allow');
});

test('decideFileChanges: add of AGENTS.md is deny', () => {
  const changes = [{
    path: alphaFile('AGENTS.md'),
    kind: { type: 'add' },
    diff: 'hello\n'
  }];
  const d = decideFileChanges(changes, alpha);
  assert.equal(d.decision, 'deny');
});

test('decideFileChanges: update outside the project is ask', () => {
  const changes = [{
    path: bravoFile('note.md'),
    kind: { type: 'update', move_path: null },
    diff: '@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n'
  }];
  const d = decideFileChanges(changes, alpha);
  assert.equal(d.decision, 'ask');
});

test('decideFileChanges: delete inside the project is ask', () => {
  const changes = [{
    path: alphaFile('note.md'),
    kind: { type: 'delete' },
    diff: 'old content\n'
  }];
  const d = decideFileChanges(changes, alpha);
  assert.equal(d.decision, 'ask');
});

test('decideFileChanges: empty array is deny', () => {
  const d = decideFileChanges([], alpha);
  assert.equal(d.decision, 'deny');
  assert.equal(d.reason, 'empty change set');
});

test('decideFileChanges: unknown kind is deny', () => {
  const changes = [{
    path: alphaFile('note.md'),
    kind: { type: 'rename' },
    diff: ''
  }];
  const d = decideFileChanges(changes, alpha);
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /unknown change kind/);
});

test('decideFileChanges: update of a .env path is deny', () => {
  const changes = [{
    path: alphaFile('.env'),
    kind: { type: 'update', move_path: null },
    diff: '@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n'
  }];
  const d = decideFileChanges(changes, alpha);
  assert.equal(d.decision, 'deny');
});
