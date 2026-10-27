import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan, loadRules, RULES } from '../scripts/denylist-scan.mjs';

// Samples are assembled from fragments so this file stays clean under its own scan.
const samples = {
  host: ['1', '92.168.1.5'].join(''),
  tailnet: ['1', '00.101.2.3'].join(''),
  secret: ['s', 'k-', 'a'.repeat(24)].join(''),
  bearer: ['Bear', 'er ', 'x'.repeat(30)].join(''),
};
// Private rules come from a maintainer file; a made-up word stands in for a private name.
const privateWord = ['zebra', 'corn'].join('');

function tmp(files) {
  const root = mkdtempSync(join(tmpdir(), 'kv-deny-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test('every generic sample category is caught', () => {
  const files = Object.fromEntries(Object.entries(samples).map(([k, v]) => [`${k}.txt`, `x ${v} y\n`]));
  const root = tmp(files);
  try {
    const hits = scan(root, [], RULES);
    for (const k of Object.keys(samples)) assert.ok(hits.some((h) => h.file === `${k}.txt`), `missed ${k}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('private rules load from a maintainer file and a missing named file throws', () => {
  const root = tmp({ 'rules.json': JSON.stringify([['name', `\\b${privateWord}\\b`, 'i']]), 'src/a.mjs': `// ${privateWord.toUpperCase()}\n` });
  try {
    const rules = loadRules(join(root, 'rules.json'));
    assert.equal(rules.length, RULES.length + 1);
    assert.deepEqual(scan(root, ['rules.json'], rules).map((h) => h.kind), ['name']);
    assert.deepEqual(scan(root, ['rules.json'], RULES), []);
    assert.throws(() => loadRules(join(root, 'missing.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clean text, near misses and skipped dirs produce no hits', () => {
  const root = tmp({
    'a.mjs': 'const skyline = 1; // 100.5.0.1, 1000.1.1.1, 192.169.0.1\n',
    'config.json': samples.secret, // skipped by the caller's skip list below
    'node_modules/x.js': samples.secret,
    'dev/tool.ps1': samples.secret,
    'scripts/denylist-scan.mjs': samples.secret,
  });
  try { assert.deepEqual(scan(root, ['config.json'], RULES), []); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only the root dev folder is skipped', () => {
  const root = tmp({ 'ui/dev/x.js': samples.secret });
  try { assert.deepEqual(scan(root, [], RULES).map((h) => h.file), ['ui/dev/x.js']); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hit reports file, line and kind', () => {
  const root = tmp({ 'src/b.mjs': `ok\n${samples.host}\n` });
  try {
    const [h] = scan(root, [], RULES);
    assert.equal(h.file, 'src/b.mjs'); assert.equal(h.line, 2); assert.equal(h.kind, 'host');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
