// Runs the host tools against a throwaway fixture project (alpha); never touches a real folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runTool, unifiedDiff } from '../tools.mjs';
import { useFixture } from './fixture.mjs';

const fixture = useFixture();
after(() => fixture.cleanup());

const alpha = { project: 'alpha', engine: 'claude', profile: 'owner' };
const bravo = { project: 'bravo', engine: 'claude', profile: 'owner' };

const tmpWriteRel = '.tmp-harness-write'; // inside the alpha project, removed after each test
const tmpWriteAbs = path.join(fixture.alpha, tmpWriteRel);

async function withTmpWrite(fn) {
  fs.mkdirSync(tmpWriteAbs, { recursive: true });
  try {
    return await fn();
  } finally {
    fs.rmSync(tmpWriteAbs, { recursive: true, force: true });
  }
}

test('read_file returns line-numbered content', async () => {
  const r = await runTool('read_file', { path: 'project-notes.md' }, alpha);
  assert.equal(r.ok, true);
  assert.match(r.result, /^1\t# Alpha project notes/);
});

test('read_file honors offset and limit', async () => {
  const full = await runTool('read_file', { path: 'project-notes.md' }, alpha);
  const lines = full.result.split('\n');
  const r = await runTool('read_file', { path: 'project-notes.md', offset: 1, limit: 1 }, alpha);
  assert.equal(r.ok, true);
  assert.equal(r.result, lines[1]);
});

test('list_dir lists the project root and includes project-notes.md', async () => {
  const r = await runTool('list_dir', { path: '.' }, alpha);
  assert.equal(r.ok, true);
  assert.ok(r.result.split('\n').some((line) => line === 'f project-notes.md'));
});

test('glob finds project-notes.md at the project root', async () => {
  const r = await runTool('glob', { pattern: 'project-notes.md' }, alpha);
  assert.equal(r.ok, true);
  assert.ok(r.result.split('\n').includes('project-notes.md'));
});

test('grep finds the markdown heading in project-notes.md', async () => {
  const r = await runTool('grep', { pattern: '^# ', path: 'project-notes.md' }, alpha);
  assert.equal(r.ok, true);
  assert.match(r.result, /^project-notes\.md:1:# Alpha project notes/);
});

test('runTool denies credential-looking paths before touching the filesystem', async () => {
  const r = await runTool('read_file', { path: '.env' }, alpha);
  assert.equal(r.ok, false);
  assert.match(r.error, /^denied:/);
});

test('read_file denies key files named without an extension', async () => {
  const r = await runTool('read_file', { path: 'nope/.service-key' }, alpha);
  assert.equal(r.ok, false);
  assert.match(r.error, /^denied:/);
});

test('grep and glob skip credential files inside a walked folder', async () => {
  const rel = '.tmp-cred';
  const dir = path.join(fixture.alpha, rel);
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const name of ['notes.md', '.env', 'x.service-key']) {
      fs.writeFileSync(path.join(dir, name), 'HARNESS_FIXTURE=dummy\n');
    }
    const g = await runTool('grep', { pattern: 'HARNESS_FIXTURE', path: rel }, alpha);
    assert.equal(g.ok, true);
    assert.deepEqual(g.result.split('\n'), ['notes.md:1:HARNESS_FIXTURE=dummy']);
    const gl = await runTool('glob', { pattern: '*', path: rel }, alpha);
    assert.deepEqual(gl.result.split('\n'), ['notes.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runTool surfaces ask decisions as a needs-approval error', async () => {
  const r = await runTool('read_file', { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' }, alpha);
  assert.equal(r.ok, false);
  assert.match(r.error, /needs approval:/);
});

test('runTool reports a clean error for a missing file instead of throwing', async () => {
  const r = await runTool('read_file', { path: 'this-file-does-not-exist.md' }, alpha);
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('write_file creates a file and returns a diff', async () => {
  await withTmpWrite(async () => {
    const r = await runTool('write_file', { path: `${tmpWriteRel}/new.md`, content: 'hello\nworld\n' }, alpha);
    assert.equal(r.ok, true);
    assert.match(r.result, /^created /);
    assert.ok(r.diff);
    assert.match(r.diff, /\+\+\+ b\//);
    assert.equal(fs.readFileSync(path.join(tmpWriteAbs, 'new.md'), 'utf8'), 'hello\nworld\n');
  });
});

test('edit_file replaces a single match', async () => {
  await withTmpWrite(async () => {
    const p = path.join(tmpWriteAbs, 'edit.md');
    fs.writeFileSync(p, 'one\ntwo\nthree\n');
    const r = await runTool('edit_file', { path: `${tmpWriteRel}/edit.md`, old_string: 'two', new_string: 'TWO' }, alpha);
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(p, 'utf8'), 'one\nTWO\nthree\n');
  });
});

test('edit_file errors when old_string matches more than once', async () => {
  await withTmpWrite(async () => {
    const p = path.join(tmpWriteAbs, 'multi.md');
    fs.writeFileSync(p, 'same\nsame\n');
    const r = await runTool('edit_file', { path: `${tmpWriteRel}/multi.md`, old_string: 'same', new_string: 'other' }, alpha);
    assert.equal(r.ok, false);
    assert.match(r.error, /old_string matches 2 times/);
  });
});

test('edit_file on a CRLF file keeps CRLF', async () => {
  await withTmpWrite(async () => {
    const p = path.join(tmpWriteAbs, 'crlf.md');
    fs.writeFileSync(p, 'one\r\ntwo\r\n');
    const r = await runTool('edit_file', { path: `${tmpWriteRel}/crlf.md`, old_string: 'two', new_string: 'TWO' }, alpha);
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(p, 'utf8'), 'one\r\nTWO\r\n');
  });
});

test('write_file adding over 40 lines succeeds', async () => {
  await withTmpWrite(async () => {
    const content = Array.from({ length: 41 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const r = await runTool('write_file', { path: `${tmpWriteRel}/big.md`, content }, alpha);
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(path.join(tmpWriteAbs, 'big.md'), 'utf8'), content);
  });
});

test('run_command without approve returns needs approval', async () => {
  const r = await runTool('run_command', { command: 'Write-Output hi' }, alpha);
  assert.equal(r.ok, false);
  assert.match(r.error, /needs approval:/);
});

test('run_command with approve resolving false returns denied by the user', async () => {
  let preview;
  const r = await runTool('run_command', { command: 'Write-Output hi' }, alpha, {
    approve: async (info) => {
      preview = info.preview;
      return false;
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'denied by the user');
  assert.equal(preview, 'Write-Output hi');
});

test('run_command with approve resolving true runs the command', async () => {
  const r = await runTool('run_command', { command: 'Write-Output hi' }, alpha, {
    approve: async () => true,
  });
  assert.equal(r.ok, true);
  assert.match(r.result, /^exit 0/);
  assert.match(r.result, /hi/);
});

test('unifiedDiff produces expected hunks', () => {
  const d = unifiedDiff('a\nb\nc', 'a\nB\nc', 'x.md');
  assert.match(d, /-b/);
  assert.match(d, /\+B/);
  assert.match(d, /@@ -1,3 \+1,3 @@/);
});

test('unifiedDiff keeps 3 context lines around a late change and merges near changes', () => {
  const old = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
  const next = [...old];
  next[19] = 'X20';
  next[22] = 'X23';
  const d = unifiedDiff(old.join('\n'), next.join('\n'), 'x.md');
  assert.equal(d.split('\n').filter((l) => l.startsWith('@@')).length, 1);
  assert.match(d, /@@ -17,10 \+17,10 @@/);
});

test('edit_file keeps $& in new_string literal', async () => {
  await withTmpWrite(async () => {
    const p = path.join(tmpWriteAbs, 'dollar.md');
    fs.writeFileSync(p, 'price\n');
    const r = await runTool('edit_file', { path: `${tmpWriteRel}/dollar.md`, old_string: 'price', new_string: 'cost $& $1' }, alpha);
    assert.equal(r.ok, true);
    assert.equal(r.result, `updated ${tmpWriteRel}/dollar.md: +1 -1 lines`);
    assert.equal(fs.readFileSync(p, 'utf8'), 'cost $& $1\n');
  });
});

test('git_status reports the branch for the session project', async () => {
  execFileSync('git', ['init', '-q'], { cwd: fixture.alpha, windowsHide: true });
  const r = await runTool('git_status', {}, alpha);
  assert.equal(r.ok, true);
  assert.match(r.result, /^branch /);
});

test('a session cannot reach a file in another project without approval', async () => {
  const r = await runTool('read_file', { path: path.join(fixture.bravo, 'project-notes.md') }, alpha);
  assert.equal(r.ok, false);
  assert.match(r.error, /needs approval:/);
  const own = await runTool('read_file', { path: 'project-notes.md' }, bravo);
  assert.equal(own.ok, true);
  assert.match(own.result, /Bravo project notes/);
});

test('an unknown project is denied', async () => {
  const r = await runTool('read_file', { path: 'x.md' }, { project: 'nope', engine: 'claude', profile: 'owner' });
  assert.equal(r.ok, false);
  assert.match(r.error, /^denied:/);
});

test('writes to protected paths are denied', async () => {
  const r = await runTool('write_file', { path: 'AGENTS.md', content: 'x' }, alpha);
  assert.equal(r.ok, false);
  assert.match(r.error, /^denied:/);
  assert.equal(fs.existsSync(path.join(fixture.alpha, 'AGENTS.md')), false);
});
