// One config file, validated on load. Nothing else in the package reads machine paths, ports or project lists.
// The file is written by the setup wizard; env vars only choose where it lives.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SCHEMA = 1;
const CODE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENGINES = ['claude', 'codex'];

export function defaultDataDir(env = process.env) {
  if (env.KEELVANE_DATA) return path.resolve(env.KEELVANE_DATA);
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Keelvane', 'data');
}

function isPort(n) {
  return Number.isInteger(n) && n >= 1024 && n <= 65535;
}

// Returns { config, errors }. Errors name the failing field so `doctor` can print them.
export function validateConfig(raw, env = process.env) {
  const errors = [];
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (input.schema !== undefined && input.schema !== SCHEMA) errors.push(`schema: expected ${SCHEMA}`);

  const dataDir = typeof input.dataDir === 'string' && input.dataDir.trim() ? path.resolve(input.dataDir) : defaultDataDir(env);
  const ports = { ui: 47310, connector: 47311, ...(input.ports || {}) };
  if (!isPort(ports.ui)) errors.push('ports.ui: must be an integer from 1024 to 65535');
  if (!isPort(ports.connector)) errors.push('ports.connector: must be an integer from 1024 to 65535');
  if (isPort(ports.ui) && ports.ui === ports.connector) errors.push('ports: ui and connector must differ');

  const projects = [];
  const seen = new Set();
  const list = input.projects === undefined ? [] : input.projects;
  if (!Array.isArray(list)) errors.push('projects: must be an array');
  else {
    list.forEach((p, i) => {
      const where = `projects[${i}]`;
      if (!p || typeof p !== 'object') return errors.push(`${where}: must be an object`);
      const code = String(p.code ?? '').toLowerCase();
      if (!CODE_RE.test(code)) errors.push(`${where}.code: use 1 to 32 letters, digits or hyphens`);
      else if (seen.has(code)) errors.push(`${where}.code: duplicate "${code}"`);
      seen.add(code);
      if (typeof p.path !== 'string' || !path.isAbsolute(p.path)) errors.push(`${where}.path: must be an absolute path`);
      const engine = p.engine === undefined ? 'claude' : p.engine;
      if (!ENGINES.includes(engine)) errors.push(`${where}.engine: must be one of ${ENGINES.join(', ')}`);
      let muse = null;
      if (p.muse !== undefined && p.muse !== null && p.muse !== false) {
        const m = p.muse === true ? {} : p.muse;
        const strings = (v, field) => {
          if (v === undefined) return [];
          if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
            errors.push(`${where}.muse.${field}: must be an array of strings`);
            return [];
          }
          return v;
        };
        const withhold = strings(m.withhold, 'withhold');
        for (const re of withhold) {
          try { new RegExp(re, 'i'); } catch { errors.push(`${where}.muse.withhold: "${re}" is not a valid pattern`); }
        }
        const inbox = m.inbox === undefined ? 'Muse-Inbox' : m.inbox;
        if (typeof inbox !== 'string' || !/^[A-Za-z0-9._-]{1,60}$/.test(inbox)) errors.push(`${where}.muse.inbox: must be a plain folder name`);
        muse = { read: strings(m.read, 'read'), withhold, inbox: String(inbox) };
      }
      if (p.private && muse) errors.push(`${where}: a private project cannot be exposed to Muse`);
      projects.push({
        code,
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : code,
        path: typeof p.path === 'string' ? path.resolve(p.path) : '',
        engine: ENGINES.includes(engine) ? engine : 'claude',
        private: Boolean(p.private),
        muse,
      });
    });
  }

  const engines = { claude: { bin: 'auto' }, codex: { bin: 'auto' } };
  for (const name of ENGINES) {
    const bin = input.engines?.[name]?.bin;
    if (bin !== undefined) {
      if (typeof bin !== 'string' || !bin.trim()) errors.push(`engines.${name}.bin: must be "auto" or a path`);
      else engines[name].bin = bin;
    }
  }

  const c = input.connector || {};
  const maxBodyBytes = c.maxBodyBytes === undefined ? 40000 : c.maxBodyBytes;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1000 || maxBodyBytes > 1_000_000) errors.push('connector.maxBodyBytes: must be an integer from 1000 to 1000000');
  const connector = {
    enabled: c.enabled !== false,
    capability: typeof c.capability === 'string' ? c.capability : '',
    serveHost: typeof c.serveHost === 'string' ? c.serveHost.toLowerCase() : '',
    tokenSha256: typeof c.tokenSha256 === 'string' ? c.tokenSha256.toLowerCase() : '',
    maxBodyBytes,
  };
  if (connector.serveHost && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(connector.serveHost)) errors.push('connector.serveHost: must be a dotted host name');
  if (connector.tokenSha256 && !/^[0-9a-f]{64}$/.test(connector.tokenSha256)) errors.push('connector.tokenSha256: must be 64 hex characters');

  const protectedGlobs = input.protectedGlobs === undefined ? ['.git/**', '**/.env', '**/*.pem'] : input.protectedGlobs;
  if (!Array.isArray(protectedGlobs) || protectedGlobs.some((g) => typeof g !== 'string')) errors.push('protectedGlobs: must be an array of strings');

  return {
    config: { schema: SCHEMA, dataDir, ports, projects, engines, connector, protectedGlobs: Array.isArray(protectedGlobs) ? protectedGlobs : [] },
    errors,
  };
}

let current = validateConfig({}).config;

export function getConfig() {
  return current;
}

// Throws with every failing field; the service refuses to start on an invalid file.
export function setConfig(raw) {
  const { config, errors } = validateConfig(raw);
  if (errors.length) throw new Error(`invalid config:\n  ${errors.join('\n  ')}`);
  current = config;
  return current;
}

export function configPath(env = process.env) {
  return env.KEELVANE_CONFIG ? path.resolve(env.KEELVANE_CONFIG) : path.join(defaultDataDir(env), 'config.json');
}

export function loadConfigFile(file = configPath()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); // tolerate a BOM from a hand edit
  } catch (error) {
    throw new Error(`cannot read config ${file}: ${error.message}`);
  }
  return setConfig(raw);
}

// Import-time load: an explicit KEELVANE_CONFIG must exist; the default file is optional (first run, tests).
if (process.env.KEELVANE_CONFIG || fs.existsSync(configPath())) loadConfigFile();
