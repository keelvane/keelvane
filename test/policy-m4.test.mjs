import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { decide, attachmentsDir } from '../policy.mjs';
import { useFixture } from './fixture.mjs';

const fixture = useFixture({ protectedGlobs: ['.git/**', '**/.env', '**/*.pem', 'private/**'] });
const dataDir = fixture.dataDir;
after(() => fixture.cleanup());

const session = { project: 'alpha', id: 's1' };

function decideFor(tool, args, s = session) {
  return decide({ tool, args }, s, { dataDir });
}

test('read_file inside own attachments dir is allowed', () => {
  const p = path.join(attachmentsDir('s1', dataDir), '123-notes.txt');
  const r = decideFor('read_file', { path: p });
  assert.equal(r.decision, 'allow');
});

test('read_file inside another session attachments dir asks', () => {
  const p = path.join(attachmentsDir('s1', dataDir), '123-notes.txt');
  const r = decideFor('read_file', { path: p }, { project: 'alpha', id: 's2' });
  assert.equal(r.decision, 'ask');
});

test('read_file of credential-like attachment is denied', () => {
  const p = path.join(attachmentsDir('s1', dataDir), '123-secrets.txt');
  const r = decideFor('read_file', { path: p });
  assert.equal(r.decision, 'deny');
});

test('sibling folder with same prefix is not treated as attachments', () => {
  const p = attachmentsDir('s1', dataDir) + 'x' + path.sep + 'a.txt';
  const r = decideFor('read_file', { path: p });
  assert.equal(r.decision, 'ask');
});

test('git_commit denies invalid or protected paths', () => {
  const cases = [
    {},
    { paths: [] },
    { paths: [''] },
    { paths: 'a.md' },
    { paths: ['a.md'] },
    { paths: ['a.md'], message: '   ' },
    { paths: ['AGENTS.md'], message: 'x' },
    { paths: ['sub/CLAUDE.md'], message: 'x' },
    { paths: ['.env'], message: 'x' },
    { paths: ['../bravo/x.md'], message: 'x' },
    { paths: [path.join(fixture.bravo, 'x.md')], message: 'x' }
  ];
  for (const args of cases) {
    const r = decideFor('git_commit', args);
    assert.equal(r.decision, 'deny', JSON.stringify(args));
  }
});

test('git_commit with valid project paths asks', () => {
  const r = decideFor('git_commit', { paths: ['notes/a.md', 'b.md'], message: 'update notes' });
  assert.equal(r.decision, 'ask');
});

test('git_commit denies a protectedGlobs folder', () => {
  const r = decideFor('git_commit', { paths: ['private/x.md'], message: 'x' }, { project: 'bravo', id: 's3' });
  assert.equal(r.decision, 'deny');
});

test('git_diff decisions', () => {
  assert.equal(decideFor('git_diff', {}).decision, 'allow');
  assert.equal(decideFor('git_diff', { path: 'notes/a.md' }).decision, 'allow');
  assert.equal(decideFor('git_diff', { path: '.env' }).decision, 'deny');
  assert.equal(decideFor('git_diff', { path: '../bravo/x.md' }).decision, 'deny');
});

test('git_status, list_skills and load_skill are allowed', () => {
  assert.equal(decideFor('git_status', {}).decision, 'allow');
  assert.equal(decideFor('list_skills', {}).decision, 'allow');
  assert.equal(decideFor('load_skill', { name: 'x' }).decision, 'allow');
});
