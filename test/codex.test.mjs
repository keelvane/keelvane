import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  listAmbientMcpServers,
  buildCodexArgs,
  formatFileChanges,
  startEngine,
  findCodexBin,
} from '../engines/codex.mjs';
import { useFixture } from './fixture.mjs';

const FAKE_PATH = fileURLToPath(new URL('./fake-codex-app-server.mjs', import.meta.url));

async function waitUntil(fn, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting');
}

const waitForEvent = (events, predicate, timeoutMs) => waitUntil(() => events.find(predicate), timeoutMs);

async function withEngine(opts, fn) {
  const events = [];
  const engine = startEngine(
    {
      sessionId: 'sess-test',
      projectRoot: os.tmpdir(),
      model: 'fake',
      runToken: 'token-test',
      hostUrl: 'http://127.0.0.1:1',
      dataDir: os.tmpdir(),
      resumeId: null,
      codexCommand: [process.execPath, FAKE_PATH],
      ...opts,
    },
    (type, payload) => events.push({ type, payload }),
  );
  try {
    return await fn(engine, events);
  } finally {
    engine.kill();
  }
}

function setCodexHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  fs.writeFileSync(path.join(dir, 'config.toml'), '[mcp_servers.node_repl]\ncommand = "x"\n');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  return () => {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

test('listAmbientMcpServers parses bare, dashed and quoted names, ignores sub-tables, detects transport', () => {
  const toml = `
[mcp_servers.node_repl]
command = "node"

[mcp_servers.local-memory]
url = "http://example.com/mcp"

[mcp_servers."a.b"]
command = "x"

[mcp_servers.node_repl.env]
SECRET = "never-returned"
url = "http://sub-table-key-must-not-count"
`;
  const servers = listAmbientMcpServers(toml);
  assert.ok(!JSON.stringify(servers).includes('never-returned'));
  assert.deepEqual(servers, [
    { name: 'node_repl', transport: 'command' },
    { name: 'local-memory', transport: 'url' },
    { name: 'a.b', transport: 'command' },
  ]);
});

test('listAmbientMcpServers deduplicates names', () => {
  const toml = `
[mcp_servers.node_repl]
command = "node"

[mcp_servers.node_repl]
url = "http://example.com/mcp"
`;
  assert.deepEqual(listAmbientMcpServers(toml), [{ name: 'node_repl', transport: 'command' }]);
});

test('buildCodexArgs includes app-server, disables, and ambient servers', () => {
  const args = buildCodexArgs({
    ambient: [
      { name: 'node_repl', transport: 'command' },
      { name: 'local-memory', transport: 'url' },
    ],
    nodePath: 'C:\\node.exe',
    toolsMcpPath: 'C:\\tools.mjs',
  });
  assert.ok(args.includes('app-server'));
  assert.ok(args.includes('--disable'));
  assert.ok(args.includes('unified_exec'));
  assert.ok(args.includes('plugins'));
  assert.ok(args.includes('hooks'));
  assert.ok(!args.includes('code_mode_host'));
  assert.ok(args.includes('mcp_servers.node_repl={command="true", enabled=false}'));
  assert.ok(args.includes('mcp_servers.local-memory={url="http://127.0.0.1:1/mcp", enabled=false}'));
  const keelvaneEntry = args.find((a) => a.startsWith('mcp_servers.keelvane='));
  assert.ok(keelvaneEntry);
  assert.ok(keelvaneEntry.includes('env_vars='));
  assert.ok(!keelvaneEntry.includes('token-test'));
});

test('buildCodexArgs throws for unsafe ambient names and skips keelvane', () => {
  assert.throws(
    () => buildCodexArgs({ ambient: [{ name: 'a.b', transport: 'command' }], nodePath: 'node', toolsMcpPath: 'tools' }),
    /cannot be disabled safely/,
  );
  const args = buildCodexArgs({
    ambient: [
      { name: 'keelvane', transport: 'command' },
      { name: 'node_repl', transport: 'command' },
    ],
    nodePath: 'node',
    toolsMcpPath: 'tools',
  });
  assert.ok(!args.some((a) => a.startsWith('mcp_servers.keelvane=') && a.includes('command="true"')));
  assert.ok(args.some((a) => a.startsWith('mcp_servers.keelvane=') && a.includes('env_vars=')));
});

test('formatFileChanges formats add, delete, and update changes', () => {
  const root = 'C:\\proj';
  const changes = [
    { path: 'C:\\proj\\a.md', kind: { type: 'add' }, diff: 'x\ny\n' },
    { path: 'C:\\proj\\b.md', kind: { type: 'delete' }, diff: 'old\n' },
    { path: 'C:\\proj\\c.md', kind: { type: 'update', move_path: null }, diff: '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n' },
  ];
  const result = formatFileChanges(changes, root);
  assert.deepEqual(result.paths, ['a.md', 'b.md', 'c.md']);
  assert.match(result.diff, /--- a\/a\.md/);
  assert.match(result.diff, /\+\+\+ b\/a\.md/);
  assert.match(result.diff, /@@ -0,0 \+1,2 @@/);
  assert.match(result.diff, /\+x/);
  assert.match(result.diff, /\+y/);
  assert.match(result.diff, /--- a\/b\.md/);
  assert.match(result.diff, /@@ -1,1 \+0,0 @@/);
  assert.match(result.diff, /-old/);
  assert.match(result.diff, /--- a\/c\.md/);
  assert.match(result.diff, /@@ -1,3 \+1,3 @@/);
  assert.match(result.diff, /-two/);
  assert.match(result.diff, /\+TWO/);
});

test('formatFileChanges keeps absolute paths outside root and uses move_path for update', () => {
  const root = 'C:\\proj';
  const changes = [
    { path: 'D:\\outside.md', kind: { type: 'add' }, diff: 'x\n' },
    { path: 'C:\\proj\\c.md', kind: { type: 'update', move_path: 'C:\\proj\\d.md' }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
  ];
  const result = formatFileChanges(changes, root);
  assert.deepEqual(result.paths, ['D:/outside.md', 'c.md']);
  assert.match(result.diff, /\+\+\+ b\/d\.md/);
});

test('adapter: hello turn produces text and usage', async () => {
  const restore = setCodexHome();
  try {
    await withEngine({}, async (engine, events) => {
      engine.send('hello');
      const finished = await waitForEvent(events, (e) => e.type === 'turn_finished' && !e.payload.stopped);
      const text = events.filter((e) => e.type === 'text_delta').map((e) => e.payload.text).join('');
      assert.equal(text, '[start] hi there');
      assert.equal(finished.payload.engine_session_id, 'thr-new');
      assert.deepEqual(finished.payload.usage, {
        input_tokens: 10,
        cache_read_input_tokens: 4,
        output_tokens: 5,
        reasoning_output_tokens: 1,
      });
    });
  } finally {
    restore();
  }
});

test('adapter: image attachments are rejected with an error and no turn starts', async () => {
  const restore = setCodexHome();
  try {
    await withEngine({}, async (engine, events) => {
      engine.send('hello', [{ mimeType: 'image/jpeg', data: '/9j/2Q==' }]);
      const err = await waitForEvent(events, (e) => e.type === 'error' && /not supported/.test(e.payload.message));
      assert.ok(err);
      assert.equal(events.filter((e) => e.type === 'turn_finished').length, 0);
    });
  } finally {
    restore();
  }
});

test('adapter: resumeId is used for thread/resume', async () => {
  const restore = setCodexHome();
  try {
    await withEngine({ resumeId: 'thr-x' }, async (engine, events) => {
      engine.send('hello');
      const finished = await waitForEvent(events, (e) => e.type === 'turn_finished' && !e.payload.stopped);
      const text = events.filter((e) => e.type === 'text_delta').map((e) => e.payload.text).join('');
      assert.ok(text.startsWith('[resume thr-x] '));
      assert.equal(finished.payload.engine_session_id, 'thr-x');
    });
  } finally {
    restore();
  }
});

test('adapter: patch approval accepts, declines, and defaults to decline', async () => {
  const restore = setCodexHome();
  try {
    await withEngine({ reviewFileChange: async () => ({ ok: true }) }, async (engine, events) => {
      engine.send('patch');
      const finished = await waitForEvent(events, (e) => e.type === 'turn_finished' && !e.payload.stopped);
      const text = events.filter((e) => e.type === 'text_delta').map((e) => e.payload.text).join('');
      assert.ok(text.includes('decision=accept'));
    });

    let receivedChanges = null;
    await withEngine({ reviewFileChange: async (changes) => { receivedChanges = changes; return { ok: false, reason: 'denied: nope' }; } }, async (engine, events) => {
      engine.send('patch');
      await waitForEvent(events, (e) => e.type === 'turn_finished' && !e.payload.stopped);
      const text = events.filter((e) => e.type === 'text_delta').map((e) => e.payload.text).join('');
      assert.ok(text.includes('decision=decline steer=Keelvane policy declined that apply_patch: denied: nope'));
      assert.equal(receivedChanges.length, 1);
      assert.equal(receivedChanges[0].path, path.win32.join('C:\\', 'proj', 'a.md'));
    });

    await withEngine({}, async (engine, events) => {
      engine.send('patch');
      await waitForEvent(events, (e) => e.type === 'turn_finished' && !e.payload.stopped);
      const text = events.filter((e) => e.type === 'text_delta').map((e) => e.payload.text).join('');
      assert.ok(text.includes('decision=decline'));
    });
  } finally {
    restore();
  }
});

test('adapter: elicitation accepts keelvane and declines others', async () => {
  const restore = setCodexHome();
  try {
    await withEngine({}, async (engine, events) => {
      engine.send('elicit');
      await waitForEvent(events, (e) => e.type === 'turn_finished' && !e.payload.stopped);
      const text = events.filter((e) => e.type === 'text_delta').map((e) => e.payload.text).join('');
      assert.ok(text.includes('a1=accept a2=decline'));
    });
  } finally {
    restore();
  }
});

test('adapter: command execution approval is declined', async () => {
  const restore = setCodexHome();
  try {
    await withEngine({}, async (engine, events) => {
      engine.send('command');
      await waitForEvent(events, (e) => e.type === 'turn_finished' && !e.payload.stopped);
      const text = events.filter((e) => e.type === 'text_delta').map((e) => e.payload.text).join('');
      assert.ok(text.includes('cmd=decline'));
    });
  } finally {
    restore();
  }
});

test('adapter: interrupt on slow turn resolves and process stays alive', async () => {
  const restore = setCodexHome();
  try {
    await withEngine({}, async (engine, events) => {
      engine.send('slow');
      await waitForEvent(events, (e) => e.type === 'text_delta' && e.payload.text === 'working');
      await engine.interrupt();
      const stopped = await waitForEvent(events, (e) => e.type === 'turn_finished' && e.payload.stopped && !e.payload.killed);
      assert.equal(stopped.payload.engine_session_id, 'thr-new');
      assert.equal(engine.exited, false);
      engine.send('hello');
      await waitForEvent(events, (e) => e.type === 'turn_finished' && !e.payload.stopped);
    });
  } finally {
    restore();
  }
});

test('adapter: interrupt on hang kills the process', async () => {
  const restore = setCodexHome();
  try {
    await withEngine({}, async (engine, events) => {
      engine.send('hang');
      await waitForEvent(events, (e) => e.type === 'text_delta' && e.payload.text === 'working');
      const start = Date.now();
      await engine.interrupt();
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 8000, `interrupt took ${elapsed}ms`);
      const stopped = await waitForEvent(events, (e) => e.type === 'turn_finished' && e.payload.stopped && e.payload.killed);
      assert.ok(stopped);
      await waitUntil(() => engine.exited);
    });
  } finally {
    restore();
  }
});

test('adapter: failed turn emits error', async () => {
  const restore = setCodexHome();
  try {
    await withEngine({}, async (engine, events) => {
      engine.send('fail');
      const err = await waitForEvent(events, (e) => e.type === 'error' && e.payload.message === 'boom');
      assert.ok(err);
    });
  } finally {
    restore();
  }
});

test('adapter: leaked ambient MCP tools cause startup error', async () => {
  const restore = setCodexHome();
  const prevLeak = process.env.FAKE_CODEX_LEAK;
  process.env.FAKE_CODEX_LEAK = '1';
  try {
    await withEngine({}, async (engine, events) => {
      const err = await waitForEvent(events, (e) => e.type === 'error' && e.payload.message.includes('node_repl'));
      assert.ok(err);
      await waitUntil(() => engine.exited);
    });
  } finally {
    if (prevLeak === undefined) delete process.env.FAKE_CODEX_LEAK;
    else process.env.FAKE_CODEX_LEAK = prevLeak;
    restore();
  }
});

test('findCodexBin prefers KEELVANE_CODEX_BIN, then the configured engine path', () => {
  const fixture = useFixture({ engines: { codex: { bin: 'C:/configured/codex.exe' } } });
  const prev = process.env.KEELVANE_CODEX_BIN;
  try {
    process.env.KEELVANE_CODEX_BIN = 'C:/env/codex.exe';
    assert.equal(findCodexBin(), 'C:/env/codex.exe');
    delete process.env.KEELVANE_CODEX_BIN;
    assert.equal(findCodexBin(), 'C:/configured/codex.exe');
  } finally {
    if (prev === undefined) delete process.env.KEELVANE_CODEX_BIN;
    else process.env.KEELVANE_CODEX_BIN = prev;
    fixture.cleanup();
  }
});

test('adapter: two sends back to back produce two turn_finished events in order', async () => {
  const restore = setCodexHome();
  try {
    await withEngine({}, async (engine, events) => {
      engine.send('hello');
      engine.send('hello');
      await waitForEvent(events, (e) => e.type === 'turn_finished' && !e.payload.stopped);
      await waitForEvent(events, (e) => events.filter((x) => x.type === 'turn_finished' && !x.payload.stopped).length === 2);
      const finished = events.filter((e) => e.type === 'turn_finished' && !e.payload.stopped);
      assert.equal(finished.length, 2);
      assert.equal(finished[0].payload.engine_session_id, 'thr-new');
      assert.equal(finished[1].payload.engine_session_id, 'thr-new');
      const errors = events.filter((e) => e.type === 'error');
      assert.equal(errors.length, 0);
    });
  } finally {
    restore();
  }
});
