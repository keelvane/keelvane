// Clean-room gate: fails when private names, hosts or secret-looking strings appear in shippable files.
// Run: node scripts/denylist-scan.mjs [root] [skip-rel-path...]
// Generic rules live here. Maintainers add private rules (their own names, hosts, project codes) in a
// JSON file of [kind, pattern, flags] rows named by KEELVANE_DENYLIST, so the private list never ships.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = 'scripts/denylist-scan.mjs';
// Root dev/ holds maintainer-only tooling that never ships; a dev folder anywhere else is scanned.
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_FILES = new Set([SELF, 'package-lock.json', '.git']);
const BINARY = /\.(png|jpe?g|gif|ico|woff2?|zip|exe|dll|node|sqlite|db)$/i;

export const RULES = [
  // private network addresses (home LAN and Tailscale CGNAT range)
  ['host', /192\.168\./],
  ['host', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
  // secrets
  ['secret', /\b(?:sk|pk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{16,}/],
  ['secret', /\bBearer\s+[A-Za-z0-9._~+=/-]{20,}/],
  ['secret', /\b[0-9a-f]{40,}\b/],
  ['secret', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export function loadRules(file = process.env.KEELVANE_DENYLIST) {
  if (!file) return RULES;
  const extra = JSON.parse(readFileSync(file, 'utf8')); // a named but missing file throws: never scan silently without it
  return [...RULES, ...extra.map(([kind, src, flags = '']) => [kind, new RegExp(src, flags)])];
}

function* walk(root, dir = root) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join('/');
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name) && rel !== 'dev') yield* walk(root, full);
    } else if (!SKIP_FILES.has(rel) && !BINARY.test(name)) yield [rel, full];
  }
}

export function scan(root, skip = [], rules = loadRules()) {
  const hits = [];
  for (const [rel, full] of walk(root)) {
    if (skip.includes(rel)) continue;
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [kind, re] of rules) {
        const m = line.match(re);
        if (m) hits.push({ file: rel, line: i + 1, kind, match: m[0] });
      }
    });
  }
  return hits;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rules = loadRules();
  const hits = scan(resolve(process.argv[2] || '.'), process.argv.slice(3), rules); // extra args: relative files to skip
  for (const h of hits) console.log(`${h.file}:${h.line} [${h.kind}] ${h.match}`);
  console.log(`denylist scan: ${hits.length} hit(s), ${rules.length} rule(s)${process.env.KEELVANE_DENYLIST ? '' : ' (generic only; set KEELVANE_DENYLIST for private rules)'}`);
  process.exit(hits.length ? 1 : 0);
}
