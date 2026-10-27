// Proves tools-mcp.mjs's explicit zod field schemas forward every argument to
// the host untouched (the "empty passthrough object" gotcha: an inputSchema
// declared as {} rather than named fields can make the SDK strip args before
// the handler ever sees them). We stand up a stub HTTP host that records the
// exact request body it received, then drive the real MCP stdio server
// through a real MCP client and compare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.resolve(__dirname, '..', 'tools-mcp.mjs');
const RUN_TOKEN = 'test-run-token';

function startStubHost() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, json: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: 'stub-result' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

test('MCP server forwards every declared argument to the host, unstripped', async () => {
  const { server, received, port } = await startStubHost();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER],
    env: {
      ...process.env,
      KEELVANE_SESSION_ID: 'session-abc',
      KEELVANE_RUN_TOKEN: RUN_TOKEN,
      KEELVANE_HOST_URL: `http://127.0.0.1:${port}`,
    },
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  try {
    await client.connect(transport);

    await client.callTool({ name: 'read_file', arguments: { path: 'x.md', offset: 2, limit: 5 } });
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['x-keelvane-run-token'], RUN_TOKEN);
    assert.deepEqual(received[0].json, {
      session_id: 'session-abc',
      tool: 'read_file',
      args: { path: 'x.md', offset: 2, limit: 5 },
    });

    await client.callTool({ name: 'grep', arguments: { pattern: 'foo', path: 'dir', ignoreCase: true } });
    assert.equal(received[1].json.args.pattern, 'foo');
    assert.equal(received[1].json.args.path, 'dir');
    assert.equal(received[1].json.args.ignoreCase, true);

    // list_dir's only field is optional; calling with no arguments at all
    // must not be rejected by the schema and must forward an empty object.
    await client.callTool({ name: 'list_dir', arguments: {} });
    assert.deepEqual(received[2].json.args, {});
  } finally {
    await client.close().catch(() => {});
    server.close();
  }
});
