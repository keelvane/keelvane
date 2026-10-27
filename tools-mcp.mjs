#!/usr/bin/env node
// Stdio MCP server named "keelvane". Exposes the M1 read tools plus the M2 write,
// and command tools and the M4 skill and git tools, and forwards every
// call to the host over HTTP;
// the host applies policy, not this file.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import http from 'node:http';

const SESSION_ID = process.env.KEELVANE_SESSION_ID || '';
const RUN_TOKEN = process.env.KEELVANE_RUN_TOKEN || '';
const HOST_URL = process.env.KEELVANE_HOST_URL || 'http://127.0.0.1:20140';

function callHost(tool, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ session_id: SESSION_ID, tool, args });
    const url = new URL('/api/tool', HOST_URL);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Keelvane-Run-Token': RUN_TOKEN,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { ok: false, error: text || res.statusMessage };
          }
          if (res.statusCode < 200 || res.statusCode >= 300 || parsed.ok === false) {
            resolve({
              content: [{ type: 'text', text: `error: ${parsed.error || res.statusMessage}` }],
              isError: true,
            });
            return;
          }
          resolve({ content: [{ type: 'text', text: String(parsed.result ?? '') }] });
        });
      }
    );
    req.on('error', (error) => {
      resolve({
        content: [{ type: 'text', text: `error: could not reach Keelvane host: ${error.message}` }],
        isError: true,
      });
    });
    req.write(body);
    req.end();
  });
}

const server = new McpServer({ name: 'keelvane', version: '0.1.0' });

server.registerTool(
  'read_file',
  {
    title: 'Read file',
    description: 'Read a text file inside the project, line numbered.',
    inputSchema: {
      path: z.string().describe('File path relative to the session project, or absolute'),
      offset: z.number().int().min(0).optional().describe('First line to return, 0-based'),
      limit: z.number().int().min(1).optional().describe('Maximum number of lines to return'),
    },
  },
  (args) => callHost('read_file', args)
);

server.registerTool(
  'list_dir',
  {
    title: 'List directory',
    description: 'List one directory inside the project.',
    inputSchema: {
      path: z.string().optional().describe('Directory path; defaults to the project root'),
    },
  },
  (args) => callHost('list_dir', args)
);

server.registerTool(
  'glob',
  {
    title: 'Glob files',
    description: 'Find files under a directory matching a glob pattern (supports *, ?, **).',
    inputSchema: {
      pattern: z.string().describe('Glob pattern, for example **/*.md'),
      path: z.string().optional().describe('Base directory to search from; defaults to the project root'),
    },
  },
  (args) => callHost('glob', args)
);

server.registerTool(
  'grep',
  {
    title: 'Grep files',
    description: 'Search for a regular expression across a file or a directory tree.',
    inputSchema: {
      pattern: z.string().describe('Regular expression to search for'),
      path: z.string().optional().describe('File or directory to search; defaults to the project root'),
      ignoreCase: z.boolean().optional().describe('Case-insensitive match'),
    },
  },
  (args) => callHost('grep', args)
);

server.registerTool(
  'write_file',
  {
    title: 'Write file',
    description:
      'Create or overwrite a text file under host policy.',
    inputSchema: {
      path: z.string().describe('File path relative to the session project, or absolute'),
      content: z.string().describe('Full UTF-8 text content to write'),
    },
  },
  (args) => callHost('write_file', args)
);

server.registerTool(
  'edit_file',
  {
    title: 'Edit file',
    description:
      'Replace an exact string in a file. old_string must match once unless replace_all is true.',
    inputSchema: {
      path: z.string().describe('File path relative to the session project, or absolute'),
      old_string: z.string().describe('Exact text to replace'),
      new_string: z.string().describe('Replacement text'),
      replace_all: z.boolean().optional().describe('Replace every match instead of requiring exactly one'),
    },
  },
  (args) => callHost('edit_file', args)
);

server.registerTool(
  'run_command',
  {
    title: 'Run command',
    description: 'Run a PowerShell command in the session project. The user approves every command first.',
    inputSchema: {
      command: z.string().describe('PowerShell command to run'),
    },
  },
  (args) => callHost('run_command', args)
);

server.registerTool(
  'list_skills',
  {
    title: 'List skills',
    description:
      'List the skills Keelvane can load (shared, Claude and Codex skill folders). Use load_skill to read one before following it.',
    inputSchema: {},
  },
  (args) => callHost('list_skills', args)
);

server.registerTool(
  'load_skill',
  {
    title: 'Load skill',
    description:
      'Return the full instructions of one skill by name, plus the folder its referenced files live in.',
    inputSchema: {
      name: z.string().describe('Skill name as shown by list_skills'),
    },
  },
  (args) => callHost('load_skill', args)
);

server.registerTool(
  'git_status',
  {
    title: 'Git status',
    description:
      'Show the branch, head and changed files inside the session project folder, paths relative to the project.',
    inputSchema: {},
  },
  (args) => callHost('git_status', args)
);

server.registerTool(
  'git_diff',
  {
    title: 'Git diff',
    description:
      'Show the diff of one changed file in the session project, or a summary of every change when path is omitted.',
    inputSchema: {
      path: z.string().optional().describe('File path relative to the session project, or absolute'),
    },
  },
  (args) => callHost('git_diff', args)
);

server.registerTool(
  'git_commit',
  {
    title: 'Git commit',
    description:
      'Commit exactly the listed changed files in the session project with a message. Only those paths are committed; nothing else that is staged is swept in. The user approves every commit first.',
    inputSchema: {
      paths: z.array(z.string()).min(1).describe('Changed files to commit, relative to the session project or absolute'),
      message: z.string().min(1).describe('Commit message'),
    },
  },
  (args) => callHost('git_commit', args)
);

const transport = new StdioServerTransport();
await server.connect(transport);
