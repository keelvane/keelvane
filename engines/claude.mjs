// Claude engine adapter: one long-lived `claude` CLI process per session,
// driven with --input-format stream-json / --output-format stream-json.
// Command and stream shapes verified in the M0 spike (DESIGN.md section 5).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.mjs';

const TOOLS_MCP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools-mcp.mjs');
// The real binary behind the npm claude.cmd shim. Spawned without a shell:
// shell:true concatenates args unquoted, which drops the empty --tools value
// and lets --tools swallow --strict-mcp-config.
// Order: env override, config engines.claude.bin, the npm global install, then PATH.
export function resolveClaudeBin() {
  if (process.env.KEELVANE_CLAUDE_BIN) return process.env.KEELVANE_CLAUDE_BIN;
  const configured = getConfig().engines.claude.bin;
  if (configured && configured !== 'auto') return configured;
  const npmGlobal = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (existsSync(npmGlobal)) return npmGlobal;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, 'claude.exe');
    if (dir && existsSync(candidate)) return candidate;
  }
  return 'claude';
}

const INTERRUPT_TIMEOUT_MS = 5000;

const MUSE_TOOLS = ['read_file', 'list_dir', 'glob', 'grep', 'write_file'];
const MUSE_DENIED = ['edit_file', 'run_command', 'list_skills', 'load_skill', 'git_status', 'git_diff', 'git_commit', 'web_fetch'];

function musePrompt(projectRoot, inbox) {
  return [
    `The session project folder is ${projectRoot}.`,
    `Pass keelvane tool paths relative to it, for example ${inbox}/note.md.`,
    'Requests come from the owner through their Muse assistant.',
    `The only writes allowed are new .md or .txt files of at most 40 lines directly inside ${inbox}, through write_file.`,
    'Nothing can be edited, overwritten or deleted, and there are no commands, web fetches, email or other projects.',
    'A line shown as [line withheld] was withheld on purpose, so never guess or reconstruct it.',
    'Replies are short plain text for a phone and never include credentials, tokens or account identifiers.',
  ].join(' ');
}

function museArgs(mcpConfigPath, model, prompt) {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--restricted',
    '--setting-sources', '',
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath,
    '--allowedTools', MUSE_TOOLS.map((t) => `mcp__keelvane__${t}`).join(','),
    '--disallowedTools', MUSE_DENIED.map((t) => `mcp__keelvane__${t}`).join(','),
    '--permission-prompts', 'none',
    '--disable-slash-commands',
    '--no-chrome',
    '--model', model,
    '--append-system-prompt', prompt,
  ];
}

function museCwd(dataDir) {
  // Empty folder so no CLAUDE.md or project settings load.
  const dir = path.join(dataDir, 'muse-cwd');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function claudeErrorMessage(obj) {
  const meaningful = value => typeof value === 'string' && value.trim().toLowerCase() !== 'success' ? value.trim() : '';
  const errors = Array.isArray(obj.errors) ? obj.errors.map(meaningful).filter(Boolean) : [];
  let message = errors.join('; ') || meaningful(obj.result) || meaningful(obj.subtype) || 'Claude could not complete this turn.';
  if (/failed to authenticate|oauth session expired|not authenticated/i.test(message)) {
    message += ' Sign in again with /login in Claude Code, then resend your message.';
  }
  return message;
}

function writeMcpConfig(dataDir, sessionId, { runToken, hostUrl }) {
  mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dataDir, `mcp-config-${sessionId}.json`);
  const config = {
    mcpServers: {
      keelvane: {
        command: process.execPath,
        args: [TOOLS_MCP_PATH],
        env: {
          KEELVANE_SESSION_ID: sessionId,
          KEELVANE_RUN_TOKEN: runToken,
          KEELVANE_HOST_URL: hostUrl,
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

export function startEngine({ sessionId, projectRoot, model, runToken, hostUrl, dataDir, resumeId, instructions = '', profile = 'owner', museInbox = 'Muse-Inbox' }, onEvent) {
  const mcpConfigPath = writeMcpConfig(dataDir, sessionId, { runToken, hostUrl });
  const promptPath = path.join(dataDir, `instructions-${sessionId}.txt`);
  writeFileSync(promptPath, `Your session project is ${projectRoot}. Pass paths to the keelvane tools relative to that folder.\n\n${instructions}`);

  const args = profile === 'muse' ? museArgs(mcpConfigPath, model, musePrompt(projectRoot, museInbox)) : [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath,
    '--allowedTools', 'mcp__keelvane',
    '--model', model,
    // Without this, models guess absolute paths and can land in the wrong project.
    '--append-system-prompt-file', promptPath,
  ];
  if (resumeId) args.push('--resume', resumeId);

  // A tool call can wait on an approval (up to 10 minutes) plus a 2 minute command.
  const env = { ...process.env, MCP_TOOL_TIMEOUT: '900000' };
  // Keep claude.ai connectors and Chrome out of Muse sessions.
  if (profile === 'muse') {
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    delete env.CLAUDE_CODE_ENABLE_CFC;
    delete env.CLAUDE_CODE_BRIDGE_CHILD_MACHINE_SETTINGS;
  }
  const child = spawn(resolveClaudeBin(), args, { cwd: profile === 'muse' ? museCwd(dataDir) : projectRoot, windowsHide: true, env });
  const pendingControls = new Map();
  let exited = false;
  let interrupting = false; // set by interrupt(), cleared by the next result

  child.on('error', (error) => {
    exited = true;
    onEvent('error', { message: `claude could not start: ${error.message}` });
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    handleLine(obj);
  });

  let stderrTail = '';
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  child.on('exit', (code, signal) => {
    rmSync(mcpConfigPath, { force: true }); // holds the run token
    rmSync(promptPath, { force: true });
    exited = true;
    for (const resolve of pendingControls.values()) resolve();
    pendingControls.clear();
    if (code !== 0 && code !== null) {
      onEvent('error', { message: `claude process exited with code ${code}${signal ? ` (${signal})` : ''}${stderrTail ? `: ${stderrTail.slice(-500)}` : ''}` });
    }
  });

  function handleLine(obj) {
    if (obj.type === 'stream_event' && obj.event?.type === 'content_block_delta') {
      const delta = obj.event.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        onEvent('text_delta', { text: delta.text });
      }
      return;
    }
    if (obj.type === 'control_response') {
      const resolve = pendingControls.get(obj.response?.request_id);
      if (resolve) {
        pendingControls.delete(obj.response.request_id);
        resolve();
      }
      return;
    }
    if (obj.type === 'result') {
      // Confirmed shape (SPIKE2-REPORT.md S1 step 4): after we send an
      // interrupt, the CLI's control_response is followed by a result event
      // with is_error:true, subtype "error_during_execution", terminal_reason
      // "aborted_streaming". That's the expected outcome of our own stop
      // request, not an engine failure, and the process stays alive and
      // accepts the next message - report it as a stopped turn, not an error.
      // A stop during a tool call ends with a different terminal_reason and an
      // [ede_diagnostic] error; after our own interrupt that is still just a stop.
      const stoppedByUs = interrupting;
      interrupting = false;
      if (obj.is_error && obj.subtype === 'error_during_execution' && (obj.terminal_reason === 'aborted_streaming' || stoppedByUs)) {
        onEvent('turn_finished', { stopped: true, engine_session_id: obj.session_id });
      } else if (obj.is_error) {
        onEvent('error', {
          message: claudeErrorMessage(obj),
          engine_session_id: obj.session_id,
        });
      } else {
        onEvent('turn_finished', {
          engine_session_id: obj.session_id,
          usage: obj.usage || null,
          cost_usd: obj.total_cost_usd ?? null,
          stop_reason: obj.stop_reason ?? null,
          subtype: obj.subtype,
        });
      }
      return;
    }
    // Other line types (system init, full assistant/user message echoes) are
    // not needed for the M1 event set; text_delta already carries the reply.
  }

  return {
    get exited() {
      return exited;
    },

    send(text) {
      if (exited) {
        onEvent('error', { message: 'engine process has already exited' });
        return;
      }
      const message = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
      child.stdin.write(JSON.stringify(message) + '\n');
    },

    interrupt() {
      if (exited) return Promise.resolve();
      interrupting = true;
      return new Promise((resolve) => {
        const requestId = randomUUID();
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(() => {
          pendingControls.delete(requestId);
          try { child.kill(); } catch { /* already gone */ }
          onEvent('turn_finished', { stopped: true, killed: true });
          finish();
        }, INTERRUPT_TIMEOUT_MS);
        pendingControls.set(requestId, () => {
          clearTimeout(timer);
          finish();
        });
        try {
          child.stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }) + '\n');
        } catch {
          clearTimeout(timer);
          pendingControls.delete(requestId);
          try { child.kill(); } catch { /* already gone */ }
          onEvent('turn_finished', { stopped: true, killed: true });
          finish();
        }
      });
    },

    kill() {
      if (exited) return;
      try { child.stdin.end(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
    },
  };
}
