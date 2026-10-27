const MAX_SIZE = 20 * 1024 * 1024;

const entries = [];

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionForMime(mime) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/avif': 'avif'
  };
  return map[mime] || 'png';
}

function makeChip(file) {
  const chip = document.createElement('div');
  chip.className = 'attach-chip uploading';

  const name = document.createElement('span');
  name.className = 'attach-name';
  name.textContent = file.name;

  const size = document.createElement('span');
  size.className = 'attach-size';
  size.textContent = humanSize(file.size);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'attach-remove';
  remove.setAttribute('aria-label', `Remove ${file.name}`);
  remove.textContent = 'x';

  chip.append(name, size, remove);
  return { chip, remove };
}

export function initAttachments({ button, input, dropZone, textarea, row, getSessionId, onError }) {
  button.addEventListener('click', () => input.click());

  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    input.value = '';
    uploadFiles(files, getSessionId, onError, row);
  });

  dropZone.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      dropZone.classList.add('dragging');
    }
  });

  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      uploadFiles(Array.from(e.dataTransfer.files), getSessionId, onError, row);
    }
  });

  textarea.addEventListener('paste', (e) => {
    const files = e.clipboardData ? Array.from(e.clipboardData.files) : [];
    if (files.length === 0) return;
    e.preventDefault();
    const renamed = files.map((file) => {
      const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
      if (!generic) return file;
      const ext = extensionForMime(file.type);
      return new File([file], `pasted-${Date.now()}.${ext}`, { type: file.type });
    });
    uploadFiles(renamed, getSessionId, onError, row);
  });

  return {
    getAttachments() {
      return entries.filter((entry) => entry.status === 'done').map((entry) => entry.result);
    },
    clear() {
      for (const entry of entries.splice(0)) {
        entry.chip.remove();
      }
    },
    isBusy() {
      return entries.some((entry) => entry.status === 'uploading');
    }
  };
}

async function uploadFiles(files, getSessionId, onError, row) {
  const sessionId = getSessionId();
  if (!sessionId) {
    onError('Start a session before attaching files.');
    return;
  }

  for (const file of files) {
    if (file.size > MAX_SIZE) {
      onError(`${file.name} is over 20 MB`);
      continue;
    }

    const { chip, remove } = makeChip(file);
    row.appendChild(chip);
    const entry = { chip, file, result: null, status: 'uploading' };
    entries.push(entry);

    remove.addEventListener('click', () => {
      const index = entries.indexOf(entry);
      if (index !== -1) entries.splice(index, 1);
      chip.remove();
    });

    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/attachments?name=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          headers: {
            'X-Keelvane-Action': 'confirmed',
            'Content-Type': 'application/octet-stream'
          },
          body: file
        }
      );
      const body = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
      if (getSessionId() !== sessionId) return;
      if (!res.ok || body.ok === false) {
        throw new Error(body.error || `request failed: ${res.status}`);
      }
      entry.result = { name: body.name, path: body.path, size: body.size };
      entry.status = 'done';
      chip.classList.remove('uploading');
    } catch (err) {
      if (getSessionId() !== sessionId) return;
      entry.status = 'error';
      chip.classList.remove('uploading');
      chip.classList.add('error');
      chip.title = err.message;
      onError(`Upload failed for ${file.name}: ${err.message}`);
    }
  }
}
