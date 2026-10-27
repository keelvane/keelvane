const SVG_NS = 'http://www.w3.org/2000/svg';

const TOOL_ICONS = {
  read: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5V13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1H6.5L2 6.5z"/><path d="M2 6.5h4.5V2"/><path d="M5 9h6M5 11.5h4"/></svg>',
  search: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
  write: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 13.5l.8-3.2L11 2.6a1.4 1.4 0 0 1 2 2l-7.7 7.7-3.2.8z"/><path d="M9.5 4.5l2 2"/></svg>',
  command: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5L2.5 7 5 9.5M11 4.5L13.5 7 11 9.5M9.5 2.5l-3 11"/></svg>',
  draft: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5h12v9H2z"/><path d="M5 6.5h6M5 9h4"/></svg>',
  other: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 5.5v3l2 1.5"/></svg>'
};

let currentSession = null;
let state = null;
let renderQueued = false;

function emptyState() {
  return {
    turns: [],
    totalCost: null,
    hasCost: false,
    tools: new Map(),
    files: new Map(),
    approvals: { pending: 0, approve: 0, deny: 0, expired: 0 }
  };
}

function compactNumber(n) {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) {
    const v = n / 1000;
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')) + 'k';
  }
  const v = n / 1000000;
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')) + 'M';
}

function formatCost(cost) {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return 'n/a';
  return '$' + cost.toFixed(4);
}

export function toolCategory(tool) {
  const t = String(tool || '');
  if (t === 'read_file' || t === 'list_dir') return 'read';
  if (t === 'grep' || t === 'glob') return 'search';
  if (t === 'write_file' || t === 'edit_file' || t === 'apply_patch') return 'write';
  if (t === 'run_command') return 'command';
  if (t === 'or_draft') return 'draft';
  return 'other';
}

export function toolIcon(tool) {
  return TOOL_ICONS[toolCategory(tool)] || TOOL_ICONS.other;
}

export function diffStats(diffText) {
  const text = String(diffText || '');
  let add = 0;
  let del = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++')) continue;
    if (line.startsWith('---')) continue;
    if (line.startsWith('+')) add++;
    else if (line.startsWith('-')) del++;
  }
  return { add, del };
}

function parseDiffFiles(diffText) {
  const text = String(diffText || '');
  const files = [];
  const lines = text.split('\n');
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('--- ')) {
      if (current) files.push(current);
      current = { header: line.slice(4).trim(), add: 0, del: 0 };
    } else if (current && line.startsWith('+++ ')) {
      current.path = line.slice(4).trim().replace(/^b\//, '');
    } else if (current && line.startsWith('+') && !line.startsWith('+++')) {
      current.add++;
    } else if (current && line.startsWith('-') && !line.startsWith('---')) {
      current.del++;
    }
  }
  if (current) files.push(current);
  return files;
}

function renderEmptyPanels() {
  const tokenTotals = document.getElementById('tokenTotals');
  if (tokenTotals) tokenTotals.textContent = '';

  const tokenChart = document.getElementById('tokenChart');
  if (tokenChart) {
    tokenChart.textContent = '';
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '130');
    text.setAttribute('y', '45');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('class', 'chart-empty');
    text.textContent = 'No completed turns yet';
    tokenChart.appendChild(text);
  }

  const toolBars = document.getElementById('toolBars');
  if (toolBars) {
    toolBars.textContent = '';
    const p = document.createElement('p');
    p.className = 'panel-empty';
    p.textContent = 'No tool calls yet';
    toolBars.appendChild(p);
  }

  const fileList = document.getElementById('fileList');
  if (fileList) {
    fileList.textContent = '';
    const li = document.createElement('li');
    li.className = 'panel-empty';
    li.textContent = 'No files changed yet';
    fileList.appendChild(li);
  }

  const approvalStats = document.getElementById('approvalStats');
  if (approvalStats) {
    approvalStats.textContent = '';
    const p = document.createElement('p');
    p.className = 'panel-empty';
    p.textContent = 'No approvals yet';
    approvalStats.appendChild(p);
  }
}

export function resetInsights(session) {
  currentSession = session || null;
  state = emptyState();
  renderEmptyPanels();
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

export function trackEvent(event) {
  if (!state) state = emptyState();
  const evt = event || {};
  const type = evt.type;
  const payload = evt.payload || {};

  if (type === 'turn_finished') {
    const usage = payload.usage || {};
    const inputTokens = Number(usage.input_tokens) || 0;
    const outputTokens = Number(usage.output_tokens) || 0;
    const cachedTokens = Number(usage.cache_read_input_tokens) || 0;
    const cacheCreation = Number(usage.cache_creation_input_tokens) || 0;
    let freshTokens;
    if (currentSession && currentSession.engine === 'codex') {
      freshTokens = Math.max(0, inputTokens - cachedTokens);
    } else {
      freshTokens = inputTokens + cacheCreation;
    }
    state.turns.push({
      seq: evt.seq,
      created_at: evt.created_at,
      input: freshTokens + cachedTokens,
      fresh: freshTokens,
      cached: cachedTokens,
      output: outputTokens
    });
    if (typeof payload.cost_usd === 'number' && Number.isFinite(payload.cost_usd)) {
      state.totalCost = (state.totalCost || 0) + payload.cost_usd;
      state.hasCost = true;
    }
  } else if (type === 'tool_started') {
    const tool = payload.tool || 'unknown';
    if (!state.tools.has(tool)) {
      state.tools.set(tool, { count: 0, errors: 0 });
    }
    state.tools.get(tool).count++;
  } else if (type === 'tool_finished') {
    const tool = payload.tool || 'unknown';
    if (!state.tools.has(tool)) {
      state.tools.set(tool, { count: 0, errors: 0 });
    }
    const ok = payload.ok !== false;
    if (!ok) {
      state.tools.get(tool).errors++;
    }
    if (ok && payload.diff) {
      const files = parseDiffFiles(payload.diff);
      for (const file of files) {
        const path = file.path || (payload.args && payload.args.path) || 'unknown';
        if (!state.files.has(path)) {
          state.files.set(path, { add: 0, del: 0 });
        }
        const entry = state.files.get(path);
        entry.add += file.add;
        entry.del += file.del;
      }
    }
  } else if (type === 'approval_requested') {
    state.approvals.pending++;
  } else if (type === 'approval_resolved') {
    if (state.approvals.pending > 0) state.approvals.pending--;
    const decision = payload.decision;
    if (decision === 'approve') state.approvals.approve++;
    else if (decision === 'deny') state.approvals.deny++;
    else if (decision === 'expired') state.approvals.expired++;
  }

  scheduleRender();
}

function renderTokens() {
  const tokenTotals = document.getElementById('tokenTotals');
  if (!tokenTotals) return;
  tokenTotals.textContent = '';

  if (state.turns.length) {
    const totalInput = state.turns.reduce((sum, t) => sum + t.input, 0);
    const totalOutput = state.turns.reduce((sum, t) => sum + t.output, 0);
    const tiles = [
      { label: 'Turns', value: compactNumber(state.turns.length) },
      { label: 'Input', value: compactNumber(totalInput) },
      { label: 'Output', value: compactNumber(totalOutput) },
      { label: 'Cost', value: state.hasCost ? formatCost(state.totalCost || 0) : 'n/a' }
    ];
    for (const tile of tiles) {
      const div = document.createElement('div');
      div.className = 'stat';
      const value = document.createElement('span');
      value.className = 'stat-value';
      value.textContent = tile.value;
      const label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = tile.label;
      div.appendChild(value);
      div.appendChild(label);
      tokenTotals.appendChild(div);
    }
  }

  const tokenChart = document.getElementById('tokenChart');
  if (!tokenChart) return;
  tokenChart.textContent = '';

  if (!state.turns.length) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '130');
    text.setAttribute('y', '45');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('class', 'chart-empty');
    text.textContent = 'No completed turns yet';
    tokenChart.appendChild(text);
    return;
  }

  const lastTurns = state.turns.slice(-24);
  const maxTotal = Math.max(1, ...lastTurns.map(t => t.input + t.output));
  const chartWidth = 260;
  const chartHeight = 90;
  const barGap = 2;
  const barWidth = Math.max(2, (chartWidth - (lastTurns.length - 1) * barGap) / lastTurns.length);

  lastTurns.forEach((turn, index) => {
    const total = turn.input + turn.output;
    const barHeight = Math.max(1, (total / maxTotal) * chartHeight);
    const x = index * (barWidth + barGap);
    const y = chartHeight - barHeight;

    const group = document.createElementNS(SVG_NS, 'g');
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = 'Turn ' + (state.turns.length - lastTurns.length + index + 1) + ': ' + compactNumber(turn.fresh) + ' input, ' + compactNumber(turn.cached) + ' cached, ' + compactNumber(turn.output) + ' output';
    group.appendChild(title);

    const cachedHeight = (turn.cached / maxTotal) * chartHeight;
    const freshHeight = (turn.fresh / maxTotal) * chartHeight;
    const outputHeight = (turn.output / maxTotal) * chartHeight;

    let currentY = chartHeight;
    if (cachedHeight > 0) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', currentY - cachedHeight);
      rect.setAttribute('width', barWidth);
      rect.setAttribute('height', cachedHeight);
      rect.setAttribute('class', 'seg-cached');
      group.appendChild(rect);
      currentY -= cachedHeight;
    }
    if (freshHeight > 0) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', currentY - freshHeight);
      rect.setAttribute('width', barWidth);
      rect.setAttribute('height', freshHeight);
      rect.setAttribute('class', 'seg-fresh');
      group.appendChild(rect);
      currentY -= freshHeight;
    }
    if (outputHeight > 0) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', currentY - outputHeight);
      rect.setAttribute('width', barWidth);
      rect.setAttribute('height', outputHeight);
      rect.setAttribute('class', 'seg-output');
      group.appendChild(rect);
    }

    tokenChart.appendChild(group);
  });
}

function renderTools() {
  const toolBars = document.getElementById('toolBars');
  if (!toolBars) return;
  toolBars.textContent = '';

  if (!state.tools.size) {
    const p = document.createElement('p');
    p.className = 'panel-empty';
    p.textContent = 'No tool calls yet';
    toolBars.appendChild(p);
    return;
  }

  const tools = Array.from(state.tools.entries()).sort((a, b) => b[1].count - a[1].count);
  const maxCount = Math.max(1, ...tools.map(([, data]) => data.count));

  for (const [tool, data] of tools) {
    const row = document.createElement('div');
    row.className = 'tool-row';

    const icon = document.createElement('span');
    icon.className = 'tool-row-icon cat-' + toolCategory(tool);
    icon.innerHTML = toolIcon(tool);
    row.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'tool-row-name';
    name.textContent = tool;
    row.appendChild(name);

    const track = document.createElement('div');
    track.className = 'tool-row-track';
    const fill = document.createElement('div');
    fill.className = 'tool-row-fill';
    fill.style.width = ((data.count / maxCount) * 100) + '%';
    track.appendChild(fill);
    if (data.errors > 0) {
      const err = document.createElement('div');
      err.className = 'tool-row-err';
      err.style.width = ((data.errors / maxCount) * 100) + '%';
      track.appendChild(err);
    }
    row.appendChild(track);

    const count = document.createElement('span');
    count.className = 'tool-row-count';
    count.textContent = String(data.count);
    row.appendChild(count);

    toolBars.appendChild(row);
  }
}

function renderFiles() {
  const fileList = document.getElementById('fileList');
  if (!fileList) return;
  fileList.textContent = '';

  if (!state.files.size) {
    const li = document.createElement('li');
    li.className = 'panel-empty';
    li.textContent = 'No files changed yet';
    fileList.appendChild(li);
    return;
  }

  const files = Array.from(state.files.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [path, data] of files) {
    const li = document.createElement('li');
    li.className = 'file-item';

    const filePath = document.createElement('span');
    filePath.className = 'file-path';
    filePath.textContent = path;
    filePath.title = path;
    li.appendChild(filePath);

    if (data.add > 0) {
      const addBadge = document.createElement('span');
      addBadge.className = 'badge add';
      addBadge.textContent = '+' + data.add;
      li.appendChild(addBadge);
    }
    if (data.del > 0) {
      const delBadge = document.createElement('span');
      delBadge.className = 'badge del';
      delBadge.textContent = '-' + data.del;
      li.appendChild(delBadge);
    }

    fileList.appendChild(li);
  }
}

function renderApprovals() {
  const approvalStats = document.getElementById('approvalStats');
  if (!approvalStats) return;
  approvalStats.textContent = '';

  const total = state.approvals.pending + state.approvals.approve + state.approvals.deny + state.approvals.expired;
  if (total === 0) {
    const p = document.createElement('p');
    p.className = 'panel-empty';
    p.textContent = 'No approvals yet';
    approvalStats.appendChild(p);
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'approval-bar';
  const segments = [
    { cls: 'seg-approved', value: state.approvals.approve },
    { cls: 'seg-denied', value: state.approvals.deny },
    { cls: 'seg-expired', value: state.approvals.expired },
    { cls: 'seg-pending', value: state.approvals.pending }
  ];
  for (const seg of segments) {
    if (seg.value > 0) {
      const div = document.createElement('div');
      div.className = seg.cls;
      div.style.width = ((seg.value / total) * 100) + '%';
      bar.appendChild(div);
    }
  }
  approvalStats.appendChild(bar);

  const chips = [
    { cls: 'approve', label: 'Approved', value: state.approvals.approve },
    { cls: 'deny', label: 'Denied', value: state.approvals.deny },
    { cls: 'expired', label: 'Expired', value: state.approvals.expired },
    { cls: 'pending', label: 'Pending', value: state.approvals.pending }
  ];
  for (const chip of chips) {
    const span = document.createElement('span');
    span.className = 'chip ' + chip.cls;
    span.textContent = chip.label + ' ' + chip.value;
    approvalStats.appendChild(span);
  }
}

function render() {
  if (!state) state = emptyState();
  renderTokens();
  renderTools();
  renderFiles();
  renderApprovals();
}
