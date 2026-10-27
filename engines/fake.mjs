// Fake engine for tests (KEELVANE_FAKE_ENGINE=1). Emits canned events and
// makes one real tool call through POST /api/tool, so tests exercise the
// whole policy/store/SSE pipeline without ever calling a model.
export function startEngine({ sessionId, runToken, hostUrl, resumeId }, onEvent) {
  let stopped = false;
  let killed = false;

  return {
    get exited() { return killed; },

    async send(rawText) {
      // remote.mjs labels every Muse turn; the tool shortcut reads past the label.
      const text = rawText.replace(/^Muse request: /, '');
      if (resumeId) {
        onEvent('text_delta', { text: `[resumed ${resumeId}] ` });
      }
      onEvent('text_delta', { text: 'Checking the project for you.\n' });

      if (text === 'hang') return; // a stuck turn: never finishes until killed

      const spam = /^spam (\d+)$/.exec(text);
      if (spam) {
        let last = '';
        for (let i = 0; i < Number(spam[1]) && !stopped; i += 1) {
          const res = await fetch(`${hostUrl}/api/tool`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Keelvane-Run-Token': runToken },
            body: JSON.stringify({ session_id: sessionId, tool: 'list_dir', args: { path: 'Muse-Inbox' } }),
          });
          const body = await res.json();
          last = body.ok ? 'ok' : `error: ${body.error}`;
        }
        onEvent('text_delta', { text: `last call: ${last}
` });
        onEvent('turn_finished', { engine_session_id: `fake-${sessionId}`, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn', subtype: 'success' });
        return;
      }

      let toolText = '';
      if (text.startsWith('tool ')) {
        try {
          const parsed = JSON.parse(text.slice(5));
          const res = await fetch(`${hostUrl}/api/tool`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Keelvane-Run-Token': runToken },
            body: JSON.stringify({
              session_id: sessionId,
              tool: parsed.tool,
              args: parsed.args || {},
            }),
          });
          const body = await res.json();
          toolText = body.ok ? String(body.result) : `error: ${body.error}`;
        } catch (error) {
          toolText = `error: ${error.message}`;
        }

        if (stopped) return;
        onEvent('text_delta', { text: `tool result: ${toolText}\n` });
        onEvent('turn_finished', {
          engine_session_id: `fake-${sessionId}`,
          usage: { input_tokens: 10, output_tokens: 20 },
          stop_reason: 'end_turn',
          subtype: 'success',
        });
        return;
      }

      try {
        const res = await fetch(`${hostUrl}/api/tool`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Keelvane-Run-Token': runToken },
          body: JSON.stringify({
            session_id: sessionId,
            tool: 'read_file',
            args: { path: 'project-notes.md', offset: 0, limit: 5 },
          }),
        });
        const body = await res.json();
        toolText = body.ok ? String(body.result) : `error: ${body.error}`;
      } catch (error) {
        toolText = `error: ${error.message}`;
      }

      if (stopped) return;
      const firstLine = (toolText.split('\n')[0] || '').replace(/^\d+\t/, '');
      onEvent('text_delta', { text: `You asked: "${text}". First line of project-notes.md: ${firstLine}\n` });
      onEvent('turn_finished', {
        engine_session_id: `fake-${sessionId}`,
        usage: { input_tokens: 10, output_tokens: 20 },
        stop_reason: 'end_turn',
        subtype: 'success',
      });
    },

    interrupt() {
      stopped = true;
      onEvent('turn_finished', { stopped: true });
      return Promise.resolve();
    },

    kill() {
      stopped = true;
      killed = true;
    },
  };
}
