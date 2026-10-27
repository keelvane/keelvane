import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { useFixture } from './fixture.mjs';
import { repoRootFor, gitStatus, gitDiff, gitCommit, formatStatus } from '../git.mjs';

const fixture = useFixture();
after(() => fixture.cleanup());

function git(args, cwd) {
  return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
}

function makeRepo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kv-git-')));
  git(['init', '-q'], dir);
  git(['config', 'user.name', 'Keelvane Test'], dir);
  git(['config', 'user.email', 'keelvane@example.invalid'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  git(['config', 'core.autocrlf', 'false'], dir);
  fs.mkdirSync(path.join(dir, 'proj'));
  fs.mkdirSync(path.join(dir, 'other'));
  fs.writeFileSync(path.join(dir, 'proj', 'a.md'), 'one\n');
  fs.writeFileSync(path.join(dir, 'proj', 'b.md'), 'two\n');
  fs.writeFileSync(path.join(dir, 'other', 'c.md'), 'three\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

test('repoRootFor returns the repo root', async () => {
  const dir = makeRepo();
  try {
    const repoRoot = await repoRootFor(path.join(dir, 'proj'));
    assert.ok(samePath(repoRoot, dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitStatus on a clean repo', async () => {
  const dir = makeRepo();
  try {
    const repoRoot = await repoRootFor(dir);
    const scopeAbs = path.join(repoRoot, 'proj');
    const status = await gitStatus({ repoRoot, scopeAbs });
    assert.deepEqual(status.files, []);
    assert.ok(typeof status.branch === 'string' && status.branch.length > 0);
    assert.match(status.head, /^[0-9a-f]{7,}$/);
    assert.equal(status.scope, 'proj');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitStatus lists only project changes', async () => {
  const dir = makeRepo();
  try {
    const repoRoot = await repoRootFor(dir);
    const scopeAbs = path.join(repoRoot, 'proj');
    fs.writeFileSync(path.join(dir, 'proj', 'a.md'), 'changed\n');
    fs.writeFileSync(path.join(dir, 'proj', 'new file.md'), 'hello\n');
    fs.writeFileSync(path.join(dir, 'other', 'c.md'), 'changed too\n');
    const status = await gitStatus({ repoRoot, scopeAbs });
    const paths = status.files.map((f) => f.path);
    assert.deepEqual(paths.sort(), ['proj/a.md', 'proj/new file.md']);
    const a = status.files.find((f) => f.path === 'proj/a.md');
    const nf = status.files.find((f) => f.path === 'proj/new file.md');
    assert.equal(a.label, 'modified');
    assert.equal(nf.label, 'untracked');
    assert.ok(!paths.some((p) => p.includes('other/c.md')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitStatus labels deleted and renamed files', async () => {
  const dir = makeRepo();
  try {
    const repoRoot = await repoRootFor(dir);
    const scopeAbs = path.join(repoRoot, 'proj');
    fs.rmSync(path.join(dir, 'proj', 'b.md'));
    let status = await gitStatus({ repoRoot, scopeAbs });
    const del = status.files.find((f) => f.path === 'proj/b.md');
    assert.equal(del.label, 'deleted');

    git(['checkout', '-q', '--', 'proj/b.md'], dir);
    git(['mv', 'proj/a.md', 'proj/renamed.md'], dir);
    status = await gitStatus({ repoRoot, scopeAbs });
    const ren = status.files.find((f) => f.path === 'proj/renamed.md');
    assert.equal(ren.label, 'renamed');
    assert.equal(ren.orig, 'proj/a.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitDiff returns diffs and rejects bad paths', async () => {
  const dir = makeRepo();
  try {
    const repoRoot = await repoRootFor(dir);
    const scopeAbs = path.join(repoRoot, 'proj');
    fs.writeFileSync(path.join(dir, 'proj', 'a.md'), 'changed\n');
    fs.writeFileSync(path.join(dir, 'proj', 'new file.md'), 'hello\n');

    const diffA = await gitDiff({ repoRoot, scopeAbs, path: 'proj/a.md' });
    assert.match(diffA, /-one/);
    assert.match(diffA, /\+changed/);

    const diffNew = await gitDiff({ repoRoot, scopeAbs, path: 'proj/new file.md' });
    assert.match(diffNew, /\+hello/);

    const diffAll = await gitDiff({ repoRoot, scopeAbs });
    assert.match(diffAll, /a\.md/);
    assert.match(diffAll, /new file\.md/);

    await assert.rejects(
      gitDiff({ repoRoot, scopeAbs, path: '../x' }),
      (err) => err.status === 400
    );
    await assert.rejects(
      gitDiff({ repoRoot, scopeAbs, path: path.join(dir, 'proj', 'a.md') }),
      (err) => err.status === 400
    );
    await assert.rejects(
      gitDiff({ repoRoot, scopeAbs, path: 'other/c.md' }),
      (err) => err.status === 400
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitCommit commits only the given paths', async () => {
  const dir = makeRepo();
  try {
    const repoRoot = await repoRootFor(dir);
    const scopeAbs = path.join(repoRoot, 'proj');
    fs.writeFileSync(path.join(dir, 'proj', 'a.md'), 'changed\n');
    fs.writeFileSync(path.join(dir, 'proj', 'new file.md'), 'hello\n');

    const result = await gitCommit({
      repoRoot,
      scopeAbs,
      paths: ['proj/a.md'],
      message: 'update a',
    });
    assert.match(result.hash, /^[0-9a-f]{7,}$/);
    assert.equal(result.subject, 'update a');

    const status = await gitStatus({ repoRoot, scopeAbs });
    const paths = status.files.map((f) => f.path);
    assert.ok(paths.includes('proj/new file.md'));
    assert.ok(!paths.includes('proj/a.md'));

    const log = git(['log', '-1', '--format=%s'], dir).trim();
    assert.equal(log, 'update a');
    const stat = git(['show', '--stat', 'HEAD'], dir);
    assert.ok(!stat.includes('new file.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitCommit rejects invalid requests without committing', async () => {
  const dir = makeRepo();
  try {
    const repoRoot = await repoRootFor(dir);
    const scopeAbs = path.join(repoRoot, 'proj');
    const headBefore = git(['rev-parse', 'HEAD'], dir).trim();

    const cases = [
      { paths: ['proj/a.md'], message: '  ' },
      { paths: [], message: 'msg' },
      { paths: ['proj/b.md'], message: 'msg' },
      { paths: ['other/c.md'], message: 'msg' },
    ];

    fs.writeFileSync(path.join(dir, 'other', 'c.md'), 'changed\n');
    fs.writeFileSync(path.join(dir, 'proj', 'AGENTS.md'), 'x\n');
    fs.writeFileSync(path.join(dir, 'proj', '.env'), 'SECRET=1\n');
    cases.push({ paths: ['proj/AGENTS.md'], message: 'msg' });
    cases.push({ paths: ['proj/.env'], message: 'msg' });

    for (const c of cases) {
      await assert.rejects(
        gitCommit({ repoRoot, scopeAbs, paths: c.paths, message: c.message }),
        (err) => err.status === 400
      );
    }

    const headAfter = git(['rev-parse', 'HEAD'], dir).trim();
    assert.equal(headAfter, headBefore);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('formatStatus uses project-relative paths', async () => {
  const dir = makeRepo();
  try {
    const repoRoot = await repoRootFor(dir);
    const scopeAbs = path.join(repoRoot, 'proj');
    fs.writeFileSync(path.join(dir, 'proj', 'a.md'), 'changed\n');
    fs.writeFileSync(path.join(dir, 'proj', 'new file.md'), 'hello\n');
    const status = await gitStatus({ repoRoot, scopeAbs });
    const text = formatStatus(status, { repoRoot, scopeAbs });
    assert.match(text, /^branch /);
    assert.match(text, /a\.md/);
    assert.match(text, /new file\.md/);
    assert.ok(!text.includes('proj/a.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
