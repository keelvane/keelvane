// Regression tests for the M5 security review (C1, C2, H1 to H4); decide() only, nothing is written.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { decide, decideFileChanges } from '../policy.mjs';
import { useFixture } from './fixture.mjs';

const fixture = useFixture();
after(() => fixture.cleanup());

const session = { project: 'alpha' };
const d = (tool, args, s = session) => decide({ tool, args }, s).decision;

test('network and device paths are denied before any filesystem call', () => {
  for (const p of ['\\\\host\\share\\x.md', '//host/share/x.md', '\\\\?\\C:\\x.md', '\\\\.\\pipe\\x']) {
    assert.equal(d('read_file', { path: p }), 'deny', p);
    assert.match(decide({ tool: 'read_file', args: { path: p } }, session).reason, /network and device/, p);
  }
});

test('NTFS stream names and drive-relative paths are denied', () => {
  for (const p of ['DESIGN.md::$DATA', 'CLAUDE.md::$DATA', 'x.env::$DATA', 'C:foo.md']) {
    assert.equal(d('read_file', { path: p }), 'deny', p);
  }
  assert.equal(d('edit_file', { path: 'CLAUDE.md::$DATA', old_string: 'a', new_string: 'b' }), 'deny', 'CLAUDE.md::$DATA edit');
  assert.equal(d('read_file', { path: path.join(fixture.alpha, 'project-notes.md') }), 'allow', 'normal absolute path');
});

test('8.3 short names are denied', () => {
  const p = '../PROJEC~1/bravo/x.md';
  assert.equal(d('read_file', { path: p }), 'deny', p);
  assert.match(decide({ tool: 'read_file', args: { path: p } }, session).reason, /8\.3/, p);
  assert.equal(d('write_file', { path: 'TAX-MA~1/x.md', content: 'x' }, { project: 'bravo' }), 'deny', 'TAX-MA~1/x.md');
});

test('engine config and instruction files are never writable', () => {
  for (const p of ['.claude/settings.json', '.codex/config.toml', 'sub/.agents/skills/x.md', '.mcp.json', 'CLAUDE.local.md', 'AGENTS.override.md', '../../.git/hooks/pre-commit']) {
    assert.equal(d('write_file', { path: p, content: 'x' }), 'deny', p);
  }
});

test('writing a script or package.json asks even inside the project', () => {
  for (const p of ['Dashboard/x.ps1', 'x.mjs', 'x.py', 'x.vbs', 'package.json']) {
    assert.equal(d('write_file', { path: p, content: 'x' }), 'ask', p);
  }
  assert.equal(d('write_file', { path: 'notes.md', content: 'x' }), 'allow', 'notes.md');
});

test('git paths get the same stream, short-name and UNC checks', () => {
  assert.equal(d('git_commit', { message: 'm', paths: ['x.md::$DATA'] }), 'deny', 'git_commit stream');
  assert.equal(d('git_diff', { path: '\\\\host\\share\\x' }), 'deny', 'git_diff UNC');
  assert.equal(d('git_diff', { path: 'PROJEC~1' }), 'deny', 'git_diff short name');
});

test('Codex file changes cannot touch engine config', () => {
  assert.equal(decideFileChanges([{ path: '.codex/config.toml', kind: { type: 'add' }, diff: 'x' }], session).decision, 'deny', '.codex/config.toml');
});

test('segments ending in a dot or space are denied (Windows strips them)', () => {
  for (const p of ['AGENTS.md.', '.claude./settings.json', 'notes /x.md', '../bravo/private./x.md']) {
    assert.equal(d('write_file', { path: p, content: 'x' }), 'deny', p);
  }
  assert.equal(decideFileChanges([{ path: 'CLAUDE.md.', kind: { type: 'add' }, diff: 'x' }], session).decision, 'deny', 'Codex CLAUDE.md.');
  assert.equal(d('read_file', { path: './project-notes.md' }), 'allow', 'dot segments still fine');
});

test('HTML pages ask and .claude.json is never writable', () => {
  assert.equal(d('write_file', { path: 'Dashboard/session-console.html', content: 'x' }), 'ask', 'html');
  assert.equal(d('write_file', { path: '../../../../.claude.json', content: 'x' }), 'deny', '.claude.json');
});
