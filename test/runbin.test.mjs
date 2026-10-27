// .cmd shims run through cmd.exe with every part quoted: spaces survive, metacharacters are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBin } from '../setup/system.mjs';

const skip = process.platform !== 'win32' ? 'Windows only' : false;

test('a .cmd in a path with spaces gets its arguments intact', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv run bin-'));
  try {
    const bin = path.join(dir, 'echo args.cmd');
    fs.writeFileSync(bin, '@echo off\r\necho [%~1] [%~2]\r\n');
    assert.equal(runBin(bin, ['-p', 'Reply with the single word ok']).trim(), '[-p] [Reply with the single word ok]');
    for (const bad of ['a"b', '100%', 'x\ny']) assert.throws(() => runBin(bin, [bad]), /unsupported character/);
    assert.throws(() => runBin(bin.replace('echo args', 'a&b'), []), /unsupported character|ENOENT|Command failed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
