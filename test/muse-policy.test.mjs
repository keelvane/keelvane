// Muse profile tests for policy.mjs and tools.mjs.
// Part 1 exercises decide() and decideFileChanges() against throwaway fixture projects.
// Part 2 exercises runTool() against the fixture's Muse-enabled project (alpha).
import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MUSE_MAX_LINES,
  decide,
  decideFileChanges,
  isGuarded,
  museContentError,
  museFilenameError,
  redactGuarded,
} from '../policy.mjs';
import { runTool, beginMuseTurn } from '../tools.mjs';
import { useFixture } from './fixture.mjs';
import { setConfig } from '../config.mjs';

const fixtures = [];

// Each call installs a fresh config, so a test may mutate its own alpha tree freely.
function fresh() {
  const fixture = useFixture();
  fixtures.push(fixture);
  return fixture;
}

function write(root, rel, content = '') {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function makeOutsideDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-muse-outside-'));
  fixtures.push({ cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) });
  return dir;
}

after(() => {
  for (const fixture of fixtures) fixture.cleanup();
});

const museSession = { id: 'muse-policy-test', project: 'alpha', engine: 'claude', profile: 'muse' };

function museDecide(tool, args, session = museSession) {
  return decide({ tool, args: args || {} }, session);
}

function assertNeverAsk(result) {
  assert.notEqual(result.decision, 'ask', `muse decision must never be ask: ${result.reason}`);
}

// --- Part 1: decide-level tests ---

test('muse reads are allowed for the configured muse.read files and the project listing', () => {
  const { alpha } = fresh();

  const cases = [
    museDecide('read_file', { path: 'README.md' }),
    museDecide('read_file', { path: 'notes/overview.md' }),
    museDecide('list_dir', {}),
    museDecide('list_dir', { path: 'notes' }),
    museDecide('glob', { pattern: '**/*.md' }),
    museDecide('grep', { pattern: 'alpha' }),
    museDecide('read_file', { path: path.join(alpha, 'README.md') }),
  ];

  for (const result of cases) {
    assertNeverAsk(result);
    assert.equal(result.decision, 'allow', result.reason);
  }
});

test('muse reads only allowlisted files; others are denied and unlisted', () => {
  const { alpha } = fresh();
  write(alpha, 'Reports/a.md', 'x\n');
  write(alpha, 'Muse-Inbox/existing.md', 'x\n');
  write(alpha, 'Session-Handoffs/s1/notes.md', 'x\n');
  write(alpha, 'Reports/nested/copy/p.md', 'x\n');
  for (const rel of ['Reports/a.md', 'notes/other.md', 'README.md.bak', 'Muse-Inbox/sub/x.md', 'Session-Handoffs/s1/notes.md', 'session-handoffs/s1/notes.md', 'Reports/nested/copy/p.md']) {
    assert.equal(museDecide('read_file', { path: rel }).decision, 'deny', rel);
  }
  assert.equal(museDecide('read_file', { path: 'Muse-Inbox/existing.md' }).decision, 'allow');
  assert.equal(museDecide('list_dir', { path: 'Reports' }).decision, 'deny');
  assert.equal(museDecide('list_dir', { path: 'SESSION-HANDOFFS' }).decision, 'deny');
  assert.equal(museDecide('glob', { path: 'Session-Handoffs', pattern: '*' }).decision, 'deny');
});

test('muse hardlinked files are denied on read and grep targets', (t) => {
  const { alpha } = fresh();
  const outside = path.join(makeOutsideDir(), 'outside.md');
  fs.writeFileSync(outside, 'zeta-text');
  const link = path.join(alpha, 'README.md');
  fs.rmSync(link);
  try { fs.linkSync(outside, link); } catch { t.skip('cannot create hardlinks here'); return; }
  assert.equal(museDecide('read_file', { path: 'README.md' }).decision, 'deny');
  assert.equal(museDecide('grep', { pattern: 'zeta', path: 'README.md' }).decision, 'deny');
  // walk() re-decides every entry, so glob and grep skip this file by the same check.
  assert.equal(museDecide('read_file', { path: 'notes' }).decision, 'allow');
});

test('muse traversal outside the project is denied', () => {
  const { bravo } = fresh();

  const cases = [
    museDecide('read_file', { path: '../bravo/project-notes.md' }),
    museDecide('read_file', { path: '..\\bravo\\project-notes.md' }),
    museDecide('read_file', { path: path.join(bravo, 'project-notes.md') }),
    museDecide('read_file', { path: 'notes/../../bravo/project-notes.md' }),
  ];

  for (const result of cases) {
    assertNeverAsk(result);
    assert.equal(result.decision, 'deny');
  }
});

test('muse sessions are denied for projects without a muse block, unknown projects and non-claude engines', () => {
  fresh();

  const sessions = [
    { id: 'x', project: 'bravo', engine: 'claude', profile: 'muse' },
    { id: 'x', project: 'nonexistent', engine: 'claude', profile: 'muse' },
    { id: 'x', project: 'alpha', engine: 'codex', profile: 'muse' },
  ];

  for (const session of sessions) {
    const result = decide({ tool: 'read_file', args: { path: 'project-notes.md' } }, session);
    assertNeverAsk(result);
    assert.equal(result.decision, 'deny');
  }
});

test('every non-Muse tool is denied for muse sessions', () => {
  fresh();

  const tools = [
    'edit_file',
    'run_command',
    'web_fetch',
    'git_status',
    'git_diff',
    'git_commit',
    'list_skills',
    'load_skill',
    'apply_patch',
    'bogus',
  ];

  for (const tool of tools) {
    const result = museDecide(tool, { path: 'README.md', command: 'x', message: 'x', paths: ['x'] });
    assertNeverAsk(result);
    assert.equal(result.decision, 'deny', `${tool} should be denied`);
  }
});

test('the .git folder is denied in any case', () => {
  const { alpha } = fresh();
  write(alpha, '.git/config', 'x\n');

  for (const rel of ['.git/config', '.GIT/config', '.Git/HEAD']) {
    const result = museDecide('read_file', { path: rel });
    assertNeverAsk(result);
    assert.equal(result.decision, 'deny', `${rel} should be denied`);
  }
  assert.equal(museDecide('list_dir', { path: '.git' }).decision, 'deny');
});

test('guarded names are checked as they sit on disk', () => {
  const { alpha } = fresh();
  write(alpha, 'Muse-Inbox/Secret-notes.md', 'x\n');
  write(alpha, 'Muse-Inbox/plain-lower.md', 'x\n');

  for (const rel of ['muse-inbox/secret-notes.md', 'Muse-Inbox/secret-notes.md', 'Muse-Inbox/SECRET-NOTES.md']) {
    const result = museDecide('read_file', { path: rel });
    assertNeverAsk(result);
    assert.equal(result.decision, 'deny', `${rel} should be denied`);
  }
  assert.equal(museDecide('read_file', { path: 'Muse-Inbox/plain-lower.md' }).decision, 'allow');
});

test('guarded paths and patterns are denied case-insensitively; unrelated patterns are allowed', () => {
  fresh();

  const denied = [
    museDecide('read_file', { path: 'secret-plan.md' }),
    museDecide('grep', { pattern: 'secret' }),
    museDecide('grep', { pattern: 'SECRET plan' }),
    museDecide('glob', { pattern: '*secret*' }),
    museDecide('glob', { pattern: '*Secret*' }),
  ];

  for (const result of denied) {
    assertNeverAsk(result);
    assert.equal(result.decision, 'deny');
  }

  const allowed = museDecide('grep', { pattern: 'plan' });
  assertNeverAsk(allowed);
  assert.equal(allowed.decision, 'allow');
});

test('credential paths are denied for muse sessions', () => {
  const { alpha } = fresh();
  write(alpha, 'api-token.txt', 'x\n');

  const result = museDecide('read_file', { path: 'api-token.txt' });
  assertNeverAsk(result);
  assert.equal(result.decision, 'deny');
});

test('unsafe paths are denied for muse sessions', () => {
  fresh();

  const paths = [
    'Reports/a.md:stream',
    '\\\\server\\share\\x.md',
    'REPORT~1/a.md',
    'Reports/a.md.',
    'Reports/a.md ',
  ];

  for (const p of paths) {
    const result = museDecide('read_file', { path: p });
    assertNeverAsk(result);
    assert.equal(result.decision, 'deny', `${p} should be denied`);
  }
});

test('grep and glob pattern caps are enforced', () => {
  fresh();

  const grepEmpty = museDecide('grep', { pattern: '' });
  assertNeverAsk(grepEmpty);
  assert.equal(grepEmpty.decision, 'deny');

  const grepLong = museDecide('grep', { pattern: 'a'.repeat(201) });
  assertNeverAsk(grepLong);
  assert.equal(grepLong.decision, 'deny');

  const grepOk = museDecide('grep', { pattern: 'a'.repeat(200) });
  assertNeverAsk(grepOk);
  assert.equal(grepOk.decision, 'allow');

  const globLong = museDecide('glob', { pattern: 'a'.repeat(121) });
  assertNeverAsk(globLong);
  assert.equal(globLong.decision, 'deny');

  const globFiveStars = museDecide('glob', { pattern: '*****' });
  assertNeverAsk(globFiveStars);
  assert.equal(globFiveStars.decision, 'deny');

  const globFourStars = museDecide('glob', { pattern: '****' });
  assertNeverAsk(globFourStars);
  assert.equal(globFourStars.decision, 'allow');
});

test('muse writes are allowed only for new inbox files with safe extensions', () => {
  const { alpha, bravo } = fresh();
  write(alpha, 'Muse-Inbox/existing.md', 'x\n');

  const allowed = [
    'Muse-Inbox/new.md',
    'Muse-Inbox/new.txt',
    'muse-inbox/new.md',
  ];

  for (const rel of allowed) {
    const result = museDecide('write_file', { path: rel, content: 'x' });
    assertNeverAsk(result);
    assert.equal(result.decision, 'allow', `${rel} should be allowed`);
  }

  const denied = [
    'Muse-Inbox/new.csv',
    'Muse-Inbox/new.js',
    'Muse-Inbox/new.mjs',
    'Muse-Inbox/new.ps1',
    'Muse-Inbox/new.html',
    'Muse-Inbox/new.bat',
    'Muse-Inbox/new.exe',
    'Muse-Inbox/noextension',
    'Muse-Inbox/con.md',
    'Muse-Inbox/aux.txt',
    'Muse-Inbox/CON.notes.md',
    'Muse-Inbox/COM1.md',
    'Muse-Inbox/LPT9.txt',
    `Muse-Inbox/${'a'.repeat(78)}.md`,
    'Muse-Inbox/é.md',
    'Muse-Inbox/bad name.md',
    'Muse-Inbox/existing.md',
    'Reports/new.md',
    'Muse-Inbox/sub/new.md',
    'Muse-Inbox/AGENTS.md',
    'Muse-Inbox/api-token.md',
    'Muse-Inbox/secret-new.md',
    path.join(bravo, 'Muse-Inbox', 'new.md'),
  ];

  for (const rel of denied) {
    const result = museDecide('write_file', { path: rel, content: 'x' });
    assertNeverAsk(result);
    assert.equal(result.decision, 'deny', `${rel} should be denied`);
  }
});

test('Muse write_file caps content at 40 lines', () => {
  fresh();

  const forty = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const fortyOne = `${forty}\nline 41`;

  const ok = museDecide('write_file', { path: 'Muse-Inbox/forty.md', content: forty });
  assertNeverAsk(ok);
  assert.equal(ok.decision, 'allow', 'accepts exactly 40 lines');
  const denied = museDecide('write_file', { path: 'Muse-Inbox/forty-one.md', content: fortyOne });
  assertNeverAsk(denied);
  assert.equal(denied.decision, 'deny', 'denies 41 lines');
  assert.match(denied.reason, /40 lines/);
});

test('owner writes retain the unrestricted line policy', () => {
  fresh();
  const content = Array.from({ length: 41 }, (_, i) => `line ${i + 1}`).join('\n');
  const result = decide({ tool: 'write_file', args: { path: 'owner.md', content } }, { project: 'alpha', engine: 'claude', profile: 'owner' });
  assert.equal(result.decision, 'allow');
});

test('Muse filename and content helpers enforce their exported contract', () => {
  assert.equal(MUSE_MAX_LINES, 40);
  assert.equal(museFilenameError(`a${'b'.repeat(76)}.md`), null);
  assert.match(museFilenameError(`a${'b'.repeat(77)}.md`), /1 to 80/);
  assert.match(museFilenameError('café.md'), /ASCII/);
  assert.match(museFilenameError('PRN.backup.txt'), /reserved/);
  assert.equal(museFilenameError('draft.TXT'), null);

  const forty = Array.from({ length: MUSE_MAX_LINES }, (_, i) => `line ${i}`).join('\r\n');
  assert.equal(museContentError(forty), null);
  assert.equal(museContentError(`${forty}\r\nlast`), 'file content exceeds 40 lines');
  assert.equal(museContentError(`${forty}\rlast`), 'file content exceeds 40 lines');
  assert.equal(museContentError(`${forty}\nlast`), 'file content exceeds 40 lines');
  assert.equal(museContentError(`${forty}\r\n`), null);
  assert.match(museContentError(null), /must be a string/);
});

test('decideFileChanges denies every change for a muse session', () => {
  fresh();

  const result = decideFileChanges(
    [{ path: 'Muse-Inbox/new.md', kind: { type: 'add' }, diff: 'x' }],
    museSession,
  );
  assertNeverAsk(result);
  assert.equal(result.decision, 'deny');
});

test('owner sessions keep ask decisions', () => {
  fresh();

  const owner = { project: 'alpha', engine: 'claude' };
  const ownerProfile = { project: 'alpha', engine: 'claude', profile: 'owner' };

  const a = decide({ tool: 'run_command', args: { command: 'x' } }, owner);
  assert.equal(a.decision, 'ask');

  const b = decide({ tool: 'run_command', args: { command: 'x' } }, ownerProfile);
  assert.equal(b.decision, 'ask');
});

test('junctions are denied for muse reads and writes', (t) => {
  const { alpha, bravo } = fresh();
  write(bravo, 'p.md', 'x\n');

  let escapeLink;
  let inboxLink;
  try {
    escapeLink = path.join(alpha, 'Escape');
    inboxLink = path.join(alpha, 'Muse-Inbox', 'link');
    fs.symlinkSync(bravo, escapeLink, 'junction');
    fs.symlinkSync(bravo, inboxLink, 'junction');
  } catch (error) {
    t.skip(`cannot create junction: ${error.message}`);
    return;
  }

  try {
    const read = museDecide('read_file', { path: 'Escape/p.md' });
    assertNeverAsk(read);
    assert.equal(read.decision, 'deny');

    const wr = museDecide('write_file', { path: 'Muse-Inbox/link/x.md', content: 'x' });
    assertNeverAsk(wr);
    assert.equal(wr.decision, 'deny');
  } finally {
    fs.rmSync(escapeLink, { force: true });
    fs.rmSync(inboxLink, { force: true });
  }
});

test('a junctioned Muse-Inbox itself is denied for writes', (t) => {
  const { alpha } = fresh();
  const outside = makeOutsideDir();
  const inbox = path.join(alpha, 'Muse-Inbox');
  fs.rmSync(inbox, { recursive: true, force: true });

  try {
    fs.symlinkSync(outside, inbox, 'junction');
  } catch (error) {
    t.skip(`cannot create junction: ${error.message}`);
    return;
  }

  try {
    const result = museDecide('write_file', { path: 'Muse-Inbox/new.md', content: 'x' });
    assertNeverAsk(result);
    assert.equal(result.decision, 'deny');
  } finally {
    fs.rmSync(inbox, { force: true });
  }
});

test('isGuarded and redactGuarded follow the project withhold patterns', () => {
  fresh();
  assert.equal(isGuarded('secret', museSession), true);
  assert.equal(isGuarded('Top SECRET plan', museSession), true);
  assert.equal(isGuarded('plain text', museSession), false);
  // A project without withhold patterns, or no session at all, guards nothing.
  assert.equal(isGuarded('secret', { project: 'bravo' }), false);
  assert.equal(isGuarded('secret', undefined), false);

  assert.equal(redactGuarded('a\r\nsecret x\nb', museSession), 'a\n[line withheld]\nb');
});

// --- Part 2: runTool tests against the fixture's Muse-enabled project ---

const run = fresh();
const inbox = path.join(run.alpha, 'Muse-Inbox');
const runMuseSession = { id: 'muse-runtool-test', project: 'alpha', engine: 'claude', profile: 'muse' };
beginMuseTurn(runMuseSession.id, 3600_000);

describe('muse runTool', () => {
  // Part 1 tests install their own configs; reinstall this one.
  before(() => setConfig(run.config));

  function tmpName(name) {
    return `tmp-muse-test-${process.pid}-${name}`;
  }

  test('muse write_file creates once and never overwrites', async () => {
    const name = tmpName('write.md');
    const abs = path.join(inbox, name);

    const first = await runTool('write_file', { path: `Muse-Inbox/${name}`, content: 'first\n' }, runMuseSession);
    assert.equal(first.ok, true, first.error);
    assert.match(first.result, /^created Muse-Inbox[\\/]/);
    assert.equal(fs.readFileSync(abs, 'utf8'), 'first\n');

    const second = await runTool('write_file', { path: `Muse-Inbox/${name}`, content: 'second\n' }, runMuseSession);
    assert.equal(second.ok, false);
    assert.match(second.error, /^denied:/);
    assert.equal(fs.readFileSync(abs, 'utf8'), 'first\n');
  });

  test('muse run_command and outside reads never call approve', async () => {
    let approveCalls = 0;
    const approve = () => {
      approveCalls++;
      return true;
    };

    const command = await runTool('run_command', { command: 'Write-Output hi' }, runMuseSession, { approve });
    assert.equal(command.ok, false);
    assert.match(command.error, /^denied:/);
    assert.equal(approveCalls, 0);

    const read = await runTool('read_file', { path: path.join(run.bravo, 'project-notes.md') }, runMuseSession, { approve });
    assert.equal(read.ok, false);
    assert.match(read.error, /^denied:/);
    assert.equal(approveCalls, 0);
  });

  test('muse grep treats the pattern as a literal string', async () => {
    const name = tmpName('grep.md');
    fs.writeFileSync(path.join(inbox, name), 'a.b\naxb\n', 'utf8');

    const literal = await runTool('grep', { pattern: 'a.b', path: `Muse-Inbox/${name}` }, runMuseSession);
    assert.equal(literal.ok, true, literal.error);
    assert.match(literal.result, /a\.b/);
    assert.doesNotMatch(literal.result, /axb/);

    const paren = await runTool('grep', { pattern: '(', path: `Muse-Inbox/${name}` }, runMuseSession);
    assert.equal(paren.ok, true);
  });

  test('muse grep drops guarded lines instead of withholding them', async () => {
    const name = tmpName('oracle.md');
    fs.writeFileSync(path.join(inbox, name), 'safe launch\nsecret launch plan\n', 'utf8');

    const shared = await runTool('grep', { pattern: 'launch', path: `Muse-Inbox/${name}` }, runMuseSession);
    assert.equal(shared.ok, true, shared.error);
    assert.equal(shared.result, `${name}:1:safe launch`);

    const onlyGuarded = await runTool('grep', { pattern: 'plan', path: `Muse-Inbox/${name}` }, runMuseSession);
    assert.equal(onlyGuarded.ok, true);
    assert.equal(onlyGuarded.result, '');
  });

  test('muse read_file redacts guarded lines', async () => {
    const name = tmpName('redact.md');
    fs.writeFileSync(path.join(inbox, name), 'safe line\nsecret launch\nSecret note\nplain ok\n', 'utf8');

    const result = await runTool('read_file', { path: `Muse-Inbox/${name}` }, runMuseSession);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result, /safe line/);
    assert.match(result.result, /plain ok/);
    assert.equal((result.result.match(/\[line withheld\]/g) || []).length, 2);
    assert.doesNotMatch(result.result, /secret launch/i);
    assert.doesNotMatch(result.result, /Secret note/);
  });

  test('muse errors scrub the project path', async () => {
    const name = tmpName('missing.md');
    const result = await runTool('read_file', { path: `Muse-Inbox/${name}` }, runMuseSession);
    assert.equal(result.ok, false);
    assert.ok(!result.error.includes(run.alpha), 'error must not contain the project root');
    assert.ok(!result.error.includes(run.alpha.replaceAll('\\', '/')), 'error must not contain forward-slash project root');
  });

  test('owner grep still uses regex patterns', async () => {
    const dir = fs.mkdtempSync(path.join(run.alpha, 'regex-fixture-'));
    const file = path.join(dir, 'source.md');
    fs.writeFileSync(file, '# Synthetic index\nplain line\n');
    const result = await runTool('grep', { pattern: '^# ', path: file }, { project: 'alpha' });
    assert.equal(result.ok, true, result.error);
    assert.match(result.result, /^source\.md:1:# Synthetic index$/);
  });
});
