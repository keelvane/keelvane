const REFRESH_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>';

const LABELS = {
  untracked: 'U',
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  conflicted: 'C'
};

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
  if (!res.ok || body.ok === false) {
    throw Object.assign(new Error(body.error || `request failed: ${res.status}`), { status: res.status });
  }
  return body;
}

function stripScope(filePath, scope) {
  if (!scope) return filePath;
  const prefix = scope + '/';
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

function displayPath(file, scope) {
  const p = stripScope(file.path, scope);
  if (file.orig) {
    return `${stripScope(file.orig, scope)} -> ${p}`;
  }
  return p;
}

export function initGitPanel({ container, renderDiff, onCount }) {
  const panel = document.createElement('div');
  panel.className = 'git-panel';
  container.appendChild(panel);

  const head = document.createElement('div');
  head.className = 'git-head';
  const branch = document.createElement('span');
  branch.className = 'git-branch';
  const hash = document.createElement('span');
  hash.className = 'git-hash';
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'git-refresh icon-btn';
  refreshBtn.setAttribute('aria-label', 'Refresh git status');
  refreshBtn.innerHTML = REFRESH_ICON;
  head.append(branch, hash, refreshBtn);

  const note = document.createElement('div');
  note.className = 'git-note';
  const error = document.createElement('div');
  error.className = 'git-error';
  error.hidden = true;
  const filesList = document.createElement('ul');
  filesList.className = 'git-files';
  const empty = document.createElement('div');
  empty.className = 'git-empty';

  const commitArea = document.createElement('div');
  commitArea.className = 'git-commit';
  const messageBox = document.createElement('textarea');
  messageBox.rows = 2;
  messageBox.placeholder = 'Commit message';
  const commitBtn = document.createElement('button');
  commitBtn.type = 'button';
  commitBtn.className = 'git-commit-btn';
  const result = document.createElement('div');
  result.className = 'git-result';
  commitArea.append(messageBox, commitBtn, result);

  panel.append(head, note, error, filesList, empty, commitArea);

  let sessionId = null;
  let requestCounter = 0;
  let currentFiles = [];
  let currentScope = '';
  const checkedPaths = new Set();

  function setError(message) {
    if (message) {
      error.textContent = message;
      error.hidden = false;
    } else {
      error.textContent = '';
      error.hidden = true;
    }
  }

  function updateCommitButton() {
    const checked = currentFiles.filter((f) => checkedPaths.has(f.path));
    const n = checked.length;
    commitBtn.textContent = `Commit selected (${n})`;
    commitBtn.disabled = n === 0 || messageBox.value.trim() === '';
  }

  function clearFiles() {
    filesList.textContent = '';
    currentFiles = [];
  }

  function renderEmpty(message) {
    empty.textContent = message;
    empty.hidden = false;
    filesList.hidden = true;
  }

  function renderFiles(files, scope) {
    empty.hidden = true;
    filesList.hidden = false;
    clearFiles();
    currentFiles = files;
    for (const file of files) {
      const li = document.createElement('li');
      li.className = 'git-file';
      const row = document.createElement('div');
      row.className = 'git-file-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = checkedPaths.has(file.path);
      checkbox.setAttribute('aria-label', displayPath(file, scope));
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) checkedPaths.add(file.path);
        else checkedPaths.delete(file.path);
        updateCommitButton();
      });
      const label = document.createElement('span');
      label.className = `git-label ${file.label}`;
      label.textContent = LABELS[file.label] || '?';
      label.title = file.label;
      const pathBtn = document.createElement('button');
      pathBtn.type = 'button';
      pathBtn.className = 'git-path';
      pathBtn.textContent = displayPath(file, scope);
      pathBtn.addEventListener('click', async () => {
        const existing = li.querySelector('.git-diff');
        if (existing) {
          existing.remove();
          return;
        }
        const pre = document.createElement('pre');
        pre.className = 'git-diff';
        pre.textContent = 'loading...';
        li.appendChild(pre);
        try {
          const body = await api(`/api/sessions/${sessionId}/git/diff?path=${encodeURIComponent(file.path)}`);
          if (!li.contains(pre)) return;
          renderDiff(pre, body.diff);
        } catch (err) {
          if (!li.contains(pre)) return;
          pre.textContent = err.message;
        }
      });
      row.append(checkbox, label, pathBtn);
      li.appendChild(row);
      filesList.appendChild(li);
    }
    updateCommitButton();
  }

  async function refresh() {
    if (!sessionId) {
      branch.textContent = '';
      hash.textContent = '';
      note.textContent = '';
      setError(null);
      clearFiles();
      renderEmpty('No session selected');
      commitArea.hidden = true;
      updateCommitButton();
      onCount?.(0);
      return;
    }
    commitArea.hidden = false;
    const reqId = ++requestCounter;
    const idAtStart = sessionId;
    try {
      const body = await api(`/api/sessions/${sessionId}/git`);
      if (reqId !== requestCounter || idAtStart !== sessionId) return;
      currentScope = body.scope || '';
      onCount?.(body.files.length);
      branch.textContent = body.branch || 'no branch';
      hash.textContent = body.head ? body.head.slice(0, 7) : '';
      const scopeText = body.scope || 'repo root';
      let noteText = `${body.files.length} changed file(s) in ${scopeText}`;
      if (body.truncated) noteText += ' (first 500 shown)';
      note.textContent = noteText;
      setError(null);
      if (body.files.length === 0) {
        clearFiles();
        renderEmpty('Working tree clean');
      } else {
        renderFiles(body.files, body.scope);
      }
    } catch (err) {
      if (reqId !== requestCounter || idAtStart !== sessionId) return;
      onCount?.(0);
      branch.textContent = '';
      hash.textContent = '';
      note.textContent = '';
      clearFiles();
      renderEmpty('');
      setError(err.message);
    }
  }

  refreshBtn.addEventListener('click', refresh);
  messageBox.addEventListener('input', updateCommitButton);

  commitBtn.addEventListener('click', async () => {
    const checked = currentFiles.filter((f) => checkedPaths.has(f.path));
    if (checked.length === 0) return;
    const message = messageBox.value.trim();
    if (!message) return;
    if (!sessionId) return;
    const paths = checked.map((f) => f.path);
    const displayPaths = checked.map((f) => displayPath(f, currentScope));
    const ok = window.confirm(`Commit ${checked.length} file(s)?\n\n${displayPaths.join('\n')}`);
    if (!ok) return;
    commitBtn.disabled = true;
    result.textContent = '';
    try {
      const body = await api(`/api/sessions/${sessionId}/git/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Keelvane-Action': 'confirmed' },
        body: JSON.stringify({ message, paths })
      });
      result.textContent = `Committed ${body.hash}: ${body.subject}`;
      messageBox.value = '';
      checkedPaths.clear();
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      updateCommitButton();
    }
  });

  function setSession(id) {
    sessionId = id;
    messageBox.value = '';
    result.textContent = '';
    setError(null);
    checkedPaths.clear();
    refresh();
  }

  refresh();

  return { setSession, refresh };
}
