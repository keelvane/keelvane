#!/usr/bin/env node
// Command line: setup | doctor | backup | update <app-dir> | rollback | uninstall | serve
// Flags: --root <dir> (default %LOCALAPPDATA%\Keelvane), --answers <file.json> (non-interactive setup),
// --dry-run (rehearse: nothing on the machine changes), --json (doctor), --yes (uninstall without asking).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { realSystem, dryRunSystem, defaultRoot, layout } from './setup/system.mjs';
import { runWizard, readLaunch } from './setup/wizard.mjs';
import { runDoctor, formatDoctor } from './setup/doctor.mjs';
import { backup, update, rollback, uninstall, findPayload, installPayload } from './setup/lifecycle.mjs';

const SELF = fileURLToPath(import.meta.url);
const USAGE = `Usage: keelvane <command> [flags]
  setup [--answers file.json] [--dry-run]   install or repair (safe to rerun)
  doctor [--json]                           health check
  backup [--out dir]                        zip config and the ledger
  update <app-dir>                          switch to a new app folder, keeps one previous
  rollback                                  go back to the previous version
  uninstall [--remove-data] [--remove-serve] [--yes] [--dry-run]
  serve                                     run the service in this window
Common: --root <dir>`;

function parseArgs(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (['answers', 'root', 'out'].includes(key)) flags[key] = argv[++i]; else flags[key] = true;
    } else rest.push(argv[i]);
  }
  return { flags, rest };
}

async function promptAnswers(rl) {
  const yes = async (q, d = true) => { const a = (await rl.question(`${q} [${d ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase(); return a ? a.startsWith('y') : d; };
  const answers = { projects: [] };
  console.log('Add your projects (folders that already exist). Leave the folder empty to finish.');
  for (;;) {
    const dir = (await rl.question('Project folder: ')).trim().replace(/^"|"$/g, '');
    if (!dir) break;
    const base = path.basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'project';
    const code = (await rl.question(`Code [${base}]: `)).trim() || base;
    const name = (await rl.question(`Display name [${code}]: `)).trim() || code;
    const engine = (await rl.question('Engine claude or codex [claude]: ')).trim() || 'claude';
    const isPrivate = await yes('Private (hidden from Muse; cross-project reads ask)?', false);
    answers.projects.push({ code, name, path: path.resolve(dir), engine, private: isPrivate });
  }
  answers.gitInit = await yes('Offer git init plus a first commit where a folder has no repo?', false);
  answers.liveCheck = await yes('Send one tiny live prompt to each CLI to check it works (uses your plan)?', false);
  answers.tailscale = await yes('Set up Tailscale for Muse?', true);
  if (answers.tailscale) answers.runServe = await yes('Run the tailscale serve command now?', false);
  answers.autostart = await yes('Start Keelvane automatically when you sign in?', true);
  return answers;
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const [command] = rest;
  const root = path.resolve(flags.root || defaultRoot());
  const log = (text) => console.log(text);
  const sys = flags['dry-run'] ? dryRunSystem(realSystem(), log) : realSystem();

  if (command === 'setup') {
    let answers;
    // Strip a BOM: PowerShell 5.1 Set-Content -Encoding UTF8 writes one, and JSON.parse rejects it.
    if (flags.answers) answers = JSON.parse(fs.readFileSync(flags.answers, 'utf8').replace(/^﻿/, ''));
    else { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); try { answers = await promptAnswers(rl); } finally { rl.close(); } }
    let launch;
    const payload = findPayload(SELF);
    if (payload && !flags['dry-run']) { // the installer replaces the app folder and node.exe, so stop the running service first
      const cur = readLaunch(root);
      if (cur && cur.version !== payload.version) sys.stopService({ launch: layout(root).launch });
    }
    if (payload) launch = flags['dry-run'] ? { node: path.join(layout(root).node, 'node.exe'), appDir: path.join(layout(root).app, payload.version), version: payload.version } : installPayload({ root, payload });
    else launch = { node: process.execPath, appDir: path.dirname(SELF), version: JSON.parse(fs.readFileSync(path.join(path.dirname(SELF), 'package.json'), 'utf8')).version };
    const report = await runWizard({ root, answers, sys, log, launch });
    console.log('\n' + formatDoctor(report.doctor));
    if (report.warnings.length) console.log('\nWarnings:\n- ' + report.warnings.join('\n- '));
    if (report.manual.length) console.log('\nYour steps:\n- ' + [...new Set(report.manual)].join('\n- '));
    process.exit(report.doctor.overall === 'red' ? 1 : 0);
  } else if (command === 'doctor') {
    const launch = readLaunch(root);
    const result = await runDoctor({ root, sys, appDir: launch?.appDir || path.dirname(SELF) });
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatDoctor(result));
    process.exit(result.overall === 'red' ? 1 : 0);
  } else if (command === 'backup') {
    console.log(`Backup written: ${backup({ root, sys, outDir: flags.out })}`);
  } else if (command === 'update') {
    if (!rest[1]) throw new Error('update needs the path of the new app folder');
    console.log(JSON.stringify(await update({ root, sys, newAppDir: path.resolve(rest[1]) }), null, 2));
  } else if (command === 'rollback') {
    console.log(JSON.stringify(await rollback({ root, sys }), null, 2));
  } else if (command === 'uninstall') {
    if (!flags.yes && !flags['dry-run']) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const a = (await rl.question(`Remove Keelvane from ${root}? Project folders are never touched. [y/N] `)).trim().toLowerCase();
      rl.close();
      if (!a.startsWith('y')) return console.log('Cancelled.');
    }
    const r = await uninstall({ root, sys, removeData: Boolean(flags['remove-data']), removeServe: Boolean(flags['remove-serve']), log });
    console.log('\nRemoved:\n- ' + (r.removed.join('\n- ') || '(nothing)'));
    console.log('Kept:\n- ' + (r.kept.join('\n- ') || '(nothing)'));
    console.log('Residue:\n- ' + (r.residue.join('\n- ') || '(none)'));
  } else if (command === 'serve') {
    process.env.KEELVANE_CONFIG ||= layout(root).config;
    await import(pathToFileURL(path.join(path.dirname(SELF), 'server.mjs')).href);
  } else {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
}

main().catch((error) => { console.error(`Error: ${error.message}`); process.exit(1); });
