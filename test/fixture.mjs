// Shared test fixture: two throwaway projects and a config file, so no test touches a real folder.
//   alpha  Muse-enabled: muse.read allowlist, a withhold pattern and an inbox
//   bravo  ordinary project, not exposed to Muse
// Use makeFixture() for a spawned server (pass fixture.env to the child) and
// useFixture() for in-process tests (it also installs the config via setConfig).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { setConfig } from '../config.mjs';

export const TOKEN = 'test-token-0123456789abcdef';
export const TOKEN_SHA256 = createHash('sha256').update(TOKEN).digest('hex');
export const CAPABILITY = 'example.test/cap/keelvane-muse';
export const SERVE_HOST = 'keelvane-test.tail0000.ts.net';

export function makeFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-fixture-'));
  const dataDir = path.join(root, 'data');
  const alpha = path.join(root, 'alpha');
  const bravo = path.join(root, 'bravo');
  for (const dir of [dataDir, alpha, bravo, path.join(alpha, 'notes'), path.join(alpha, 'Muse-Inbox')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(alpha, 'project-notes.md'), '# Alpha project notes\n\nFirst line of notes.\n');
  fs.writeFileSync(path.join(alpha, 'README.md'), '# Alpha readme\n');
  fs.writeFileSync(path.join(alpha, 'notes', 'overview.md'), '# Alpha overview\n');
  fs.writeFileSync(path.join(alpha, 'secret-plan.md'), '# secret plan\n');
  fs.writeFileSync(path.join(bravo, 'project-notes.md'), '# Bravo project notes\n');

  const config = {
    schema: 1,
    dataDir,
    ports: { ui: 47310, connector: 47311 },
    projects: [
      { code: 'alpha', name: 'Alpha', path: alpha, engine: 'claude', private: false, muse: { read: ['README.md', 'notes/overview.md', 'project-notes.md'], withhold: ['secret'], inbox: 'Muse-Inbox' } },
      { code: 'bravo', name: 'Bravo', path: bravo, engine: 'claude', private: false },
    ],
    connector: { enabled: true, capability: CAPABILITY, serveHost: SERVE_HOST, tokenSha256: TOKEN_SHA256, maxBodyBytes: 40000 },
    ...overrides,
  };
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  return {
    root, dataDir, alpha, bravo, config, configFile,
    env: { KEELVANE_CONFIG: configFile, KEELVANE_DATA: dataDir },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function useFixture(overrides) {
  const fixture = makeFixture(overrides);
  setConfig(fixture.config);
  return fixture;
}
