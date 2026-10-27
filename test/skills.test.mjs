import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSkills, loadSkill, listSkillsTool, loadSkillTool } from '../skills.mjs';

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-skills-'));
  const shared = path.join(dir, 'shared');
  const claude = path.join(dir, 'claude');
  const codex = path.join(dir, 'codex');
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });

  fs.writeFileSync(path.join(shared, 'alpha.md'), '# Alpha skill\n\nDoes alpha things\nacross two lines.\n\n## More\nbody\n');
  fs.writeFileSync(path.join(shared, 'dup.md'), '# Dup\n\nShared version wins.\n');
  fs.writeFileSync(path.join(shared, 'notes.txt'), 'not a skill');

  fs.mkdirSync(path.join(claude, 'beta'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: "Beta desc"\n---\n\nbody\n');
  fs.mkdirSync(path.join(claude, 'dup'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'dup', 'SKILL.md'), '---\nname: dup\ndescription: Claude dup\n---\n\nbody\n');
  fs.mkdirSync(path.join(claude, 'gamma'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'gamma', 'SKILL.md'), '---\nname: gamma\ndescription: >\n  Line one\n  line two\n---\n\nbody mentions mcp__claude-in-chrome__navigate\n');
  fs.mkdirSync(path.join(claude, 'synced', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'synced', 'nested', 'SKILL.md'), '---\nname: nested\ndescription: nested\n---\n\nbody\n');
  fs.mkdirSync(path.join(claude, 'nofile'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'nofile', 'readme.md'), 'not a skill');
  fs.mkdirSync(path.join(claude, 'bad name!'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'bad name!', 'SKILL.md'), '---\nname: bad name!\ndescription: bad\n---\n\nbody\n');

  fs.mkdirSync(path.join(codex, '.system', 'hidden'), { recursive: true });
  fs.writeFileSync(path.join(codex, '.system', 'hidden', 'SKILL.md'), '---\nname: hidden\ndescription: hidden\n---\n\nbody\n');
  fs.mkdirSync(path.join(codex, 'delta'), { recursive: true });
  fs.writeFileSync(path.join(codex, 'delta', 'SKILL.md'), '---\r\nname: delta\r\ndescription: \'Delta desc\'\r\n---\r\n\r\nbody\r\n');

  return {
    dir,
    roots: [
      { source: 'shared', dir: shared, flat: true },
      { source: 'claude', dir: claude, flat: false },
      { source: 'codex', dir: codex, flat: false }
    ]
  };
}

test('listSkills returns exactly alpha, beta, delta, dup, gamma sorted with correct sources', () => {
  const { dir, roots } = makeTree();
  try {
    const skills = listSkills(roots);
    assert.deepEqual(skills.map(s => s.name), ['alpha', 'beta', 'delta', 'dup', 'gamma']);
    const byName = Object.fromEntries(skills.map(s => [s.name, s]));
    assert.equal(byName.alpha.source, 'shared');
    assert.equal(byName.beta.source, 'claude');
    assert.equal(byName.delta.source, 'codex');
    assert.equal(byName.dup.source, 'shared');
    assert.equal(byName.gamma.source, 'claude');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('descriptions are parsed correctly', () => {
  const { dir, roots } = makeTree();
  try {
    const skills = listSkills(roots);
    const byName = Object.fromEntries(skills.map(s => [s.name, s]));
    assert.equal(byName.alpha.description, 'Does alpha things across two lines.');
    assert.equal(byName.beta.description, 'Beta desc');
    assert.equal(byName.gamma.description, 'Line one line two');
    assert.equal(byName.delta.description, 'Delta desc');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dup comes from shared priority with shared description', () => {
  const { dir, roots } = makeTree();
  try {
    const skills = listSkills(roots);
    const dup = skills.find(s => s.name === 'dup');
    assert.equal(dup.source, 'shared');
    assert.equal(dup.description, 'Shared version wins.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gamma unsupported mentions browser; beta unsupported is null', () => {
  const { dir, roots } = makeTree();
  try {
    const skills = listSkills(roots);
    const gamma = skills.find(s => s.name === 'gamma');
    const beta = skills.find(s => s.name === 'beta');
    assert.ok(typeof gamma.unsupported === 'string' && gamma.unsupported.length > 0);
    assert.ok(gamma.unsupported.includes('browser'));
    assert.equal(beta.unsupported, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSkill returns text and source; case-insensitive lookup works', () => {
  const { dir, roots } = makeTree();
  try {
    const beta = loadSkill('beta', roots);
    assert.ok(beta.text.includes('name: beta'));
    assert.equal(beta.source, 'claude');
    const upper = loadSkill('BETA', roots);
    assert.ok(upper);
    assert.equal(upper.name, 'beta');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSkill returns null for invalid names', () => {
  const { dir, roots } = makeTree();
  try {
    assert.equal(loadSkill('nope', roots), null);
    assert.equal(loadSkill('../beta', roots), null);
    assert.equal(loadSkill('beta/../../x', roots), null);
    assert.equal(loadSkill('', roots), null);
    assert.equal(loadSkill(undefined, roots), null);
    assert.equal(loadSkill(42, roots), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skill file larger than 64 KB is truncated with marker', () => {
  const { dir, roots } = makeTree();
  try {
    const big = path.join(roots[0].dir, 'big.md');
    fs.writeFileSync(big, '# Big\n\n' + 'x'.repeat(70 * 1024));
    const skill = loadSkill('big', roots);
    assert.ok(skill);
    assert.ok(skill.text.endsWith('[skill truncated at 64 KB]'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listSkillsTool and loadSkillTool honor KEELVANE_SKILL_ROOTS', () => {
  const { dir, roots } = makeTree();
  const prev = process.env.KEELVANE_SKILL_ROOTS;
  try {
    process.env.KEELVANE_SKILL_ROOTS = JSON.stringify(roots);
    const listOut = listSkillsTool({}, {});
    assert.ok(listOut.includes('alpha (shared): Does alpha things across two lines.'));
    assert.ok(listOut.includes('[limited:'));
    const loadOut = loadSkillTool({ name: 'beta' }, {});
    assert.ok(loadOut.startsWith('Skill "beta" (claude).'));
    assert.throws(() => loadSkillTool({ name: 'nope' }, {}), /unknown skill/);
  } finally {
    if (prev === undefined) {
      delete process.env.KEELVANE_SKILL_ROOTS;
    } else {
      process.env.KEELVANE_SKILL_ROOTS = prev;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing root dir is ignored', () => {
  const { dir, roots } = makeTree();
  try {
    const extraRoots = [...roots, { source: 'missing', dir: path.join(dir, 'does-not-exist'), flat: false }];
    const skills = listSkills(extraRoots);
    assert.deepEqual(skills.map(s => s.name), ['alpha', 'beta', 'delta', 'dup', 'gamma']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
