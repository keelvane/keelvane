import { marked } from '/vendor/marked.esm.js';

// Model output is untrusted: raw HTML shows as text, so injected markup cannot
// redirect the tab (meta refresh) or draw a fake approval card.
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
marked.use({ renderer: { html: ({ text }) => escapeHtml(text) } });
import { resetInsights, trackEvent, diffStats, toolIcon, toolCategory } from './insights.js';
import { initSkillsMenu, findSkill } from './skills-menu.js';
import { initAttachments } from './attachments.js';
import { initGitPanel } from './git-panel.js';

let PROJECTS = [];
function projectColor(code) {
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}

const modelSelect = document.getElementById('modelSelect');
const engineToggle = document.getElementById('engineToggle');
const sessionList = document.getElementById('sessionList');
const chat = document.getElementById('chat');
const composerForm = document.getElementById('composerForm');
const composerText = document.getElementById('composerText');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const insightsToggle = document.getElementById('insightsToggle');
const app = document.getElementById('app');
const hdrVault = document.getElementById('hdrVault');
const hdrEngine = document.getElementById('hdrEngine');
const hdrModel = document.getElementById('hdrModel');
const hdrStatus = document.getElementById('hdrStatus');
const archiveBtn = document.getElementById('archiveBtn');

const MODEL_OPTIONS = {
  claude: ['sonnet', 'haiku', 'opus'],
  codex: ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol'],
};

function currentEngine() {
  const active = engineToggle.querySelector('.engine-opt.active');
  return active ? active.dataset.engine : 'claude';
}

function populateModelSelect() {
  modelSelect.innerHTML = '';
  for (const model of MODEL_OPTIONS[currentEngine()]) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = model;
    modelSelect.appendChild(opt);
  }
}

for (const btn of engineToggle.querySelectorAll('.engine-opt')) {
  btn.addEventListener('click', () => {
    for (const other of engineToggle.querySelectorAll('.engine-opt')) {
      other.classList.remove('active');
      other.setAttribute('aria-checked', 'false');
    }
    btn.classList.add('active');
    btn.setAttribute('aria-checked', 'true');
    populateModelSelect();
  });
}

populateModelSelect();

let sessions = [];
let currentSessionId = null;
let eventSource = null;
let currentAssistantEl = null;
let assistantBuffer = '';
const pendingTools = [];
let running = false;
let sending = false;

sidebarToggle.addEventListener('click', () => sidebar.classList.toggle('open'));

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function relativeTime(updatedAt) {
  const then = new Date(updatedAt).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function setHeader(session) {
  archiveBtn.hidden = !session;
  if (!session) {
    hdrVault.textContent = '';
    hdrVault.className = 'vault-chip';
    hdrEngine.textContent = '';
    hdrEngine.className = 'engine-badge';
    hdrModel.textContent = '';
    setStatus('idle', 'no session');
    return;
  }
  hdrVault.textContent = session.project;
  hdrVault.className = 'vault-chip';
  hdrVault.style.setProperty('--chip', projectColor(session.project));
  hdrEngine.textContent = session.engine === 'codex' ? 'Codex' : 'Claude';
  hdrEngine.className = `engine-badge ${session.engine}`;
  hdrModel.textContent = session.model || '';
  setStatus(session.status || 'idle', session.status || 'idle');
}

function setStatus(status, label) {
  hdrStatus.className = `status-pill ${status}`;
  const labelEl = hdrStatus.querySelector('.label');
  if (labelEl) labelEl.textContent = label;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
  if (!res.ok || body.ok === false) {
    throw Object.assign(new Error(body.error || `request failed: ${res.status}`), { status: res.status });
  }
  return body;
}

function setRunning(next) {
  running = next;
  sendBtn.disabled = running;
  stopBtn.disabled = !running;
  if (running) {
    setStatus('running', 'running');
  } else if (currentSessionId) {
    const session = sessions.find((s) => s.id === currentSessionId);
    setStatus(session ? session.status || 'idle' : 'idle', session ? session.status || 'idle' : 'idle');
  } else {
    setStatus('idle', 'no session');
  }
}

function mainSessionFor(project) {
  let main = null;
  for (const s of sessions) {
    if (s.project !== project) continue;
    if (!main || s.created_at < main.created_at) main = s;
  }
  return main;
}

async function createSession(project) {
  try {
    const body = await api('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Keelvane-Action': 'confirmed' },
      body: JSON.stringify({ project, engine: currentEngine(), model: modelSelect.value }),
    });
    await refreshSessions();
    selectSession(body.session.id);
    sidebar.classList.remove('open');
  } catch (error) {
    alert(`Could not start session: ${error.message}`);
  }
}

function sessionItem(s) {
  const item = document.createElement('div');
  item.className = 'session-item child' + (s.id === currentSessionId ? ' active' : '');
  const dot = document.createElement('span');
  dot.className = `status-dot ${s.status || 'idle'}`;
  const body = document.createElement('div');
  body.className = 'session-body';
  const title = document.createElement('div');
  title.className = 'session-title';
  title.textContent = s.title || `${s.engine === 'codex' ? 'Codex' : 'Claude'} session`;
  const sub = document.createElement('div');
  sub.className = 'session-sub';
  const engineBadge = document.createElement('span');
  engineBadge.className = `engine-badge ${s.engine}`;
  engineBadge.textContent = s.engine === 'codex' ? 'Codex' : 'Claude';
  const model = document.createElement('span');
  model.className = 'session-model';
  model.textContent = s.model || '';
  const time = document.createElement('span');
  time.className = 'session-time';
  time.textContent = relativeTime(s.updated_at);
  sub.appendChild(engineBadge);
  sub.appendChild(model);
  sub.appendChild(time);
  body.appendChild(title);
  body.appendChild(sub);
  item.appendChild(dot);
  item.appendChild(body);
  if (s.pending_approvals > 0 && s.id !== currentSessionId) {
    const badge = document.createElement('span');
    badge.className = 'pending-badge';
    badge.textContent = String(s.pending_approvals);
    badge.title = `${s.pending_approvals} approval(s) waiting`;
    item.appendChild(badge);
  }
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'session-menu-btn';
  menuBtn.textContent = '⋮';
  menuBtn.setAttribute('aria-label', 'Session actions');
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openSessionMenu(s, menuBtn); });
  item.appendChild(menuBtn);
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.addEventListener('click', () => selectSession(s.id));
  item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSession(s.id); } });
  return item;
}

let openMenu = null;
function closeSessionMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}
document.addEventListener('click', closeSessionMenu);

async function archiveSession(s) {
  if (sending) return;
  if (!confirm(`Archive \"${s.title || 'this session'}\"? It leaves the sidebar; its history stays on disk.`)) return;
  try {
    await api(`/api/sessions/${s.id}/archive`, { method: 'POST', headers: { 'X-Keelvane-Action': 'confirmed' } });
  } catch (error) {
    alert(`Could not archive: ${error.message}`);
    return;
  }
  if (s.id === currentSessionId) {
    if (eventSource) eventSource.close();
    eventSource = null;
    currentSessionId = null;
    resetChatState();
    setHeader(null);
    resetInsights(null);
    attachments.clear();
    gitPanel.setSession(null);
    renderEmptyState();
  }
  await refreshSessions();
  renderSessionList();
}

async function renameSession(s) {
  if (sending) return;
  const title = prompt('Rename session', s.title || '');
  if (title === null || !title.trim()) return;
  try {
    await api(`/api/sessions/${s.id}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Keelvane-Action': 'confirmed' },
      body: JSON.stringify({ title: title.trim() }),
    });
  } catch (error) {
    alert(`Could not rename: ${error.message}`);
    return;
  }
  await refreshSessions();
  renderSessionList();
}

async function deleteSession(s) {
  if (sending) return;
  if (!confirm(`Delete \"${s.title || 'this session'}\"? This cannot be undone.`)) return;
  try {
    await api(`/api/sessions/${s.id}`, { method: 'DELETE', headers: { 'X-Keelvane-Action': 'confirmed' } });
  } catch (error) {
    alert(`Could not delete: ${error.message}`);
    return;
  }
  if (s.id === currentSessionId) {
    if (eventSource) eventSource.close();
    eventSource = null;
    currentSessionId = null;
    resetChatState();
    setHeader(null);
    resetInsights(null);
    attachments.clear();
    gitPanel.setSession(null);
    renderEmptyState();
  }
  await refreshSessions();
  renderSessionList();
}

function openSessionMenu(s, anchor) {
  closeSessionMenu();
  const menu = document.createElement('div');
  menu.className = 'session-menu';
  const actions = [
    ['Rename', () => renameSession(s)],
    ['Archive', () => archiveSession(s)],
    ['Delete', () => deleteSession(s)],
  ];
  for (const [label, handler] of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    if (label === 'Delete') btn.className = 'danger';
    btn.addEventListener('click', (e) => { e.stopPropagation(); closeSessionMenu(); handler(); });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const top = rect.bottom + 4 + menu.offsetHeight <= window.innerHeight - 4
    ? rect.bottom + 4 : rect.top - menu.offsetHeight - 4;
  menu.style.top = `${Math.max(4, top)}px`;
  menu.style.left = `${Math.max(4, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 4))}px`;
  openMenu = menu;
}

function renderSessionList() {
  sessionList.innerHTML = '';
  for (const proj of PROJECTS) {
    const vault = proj.code;
    const projectSessions = sessions.filter((s) => s.project === vault);
    const main = mainSessionFor(vault);
    const row = document.createElement('div');
    row.className = 'project-item' + (main && main.id === currentSessionId ? ' active' : '') + (projectSessions.length === 0 ? ' empty' : '');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.title = main ? (main.title || 'Open main session') : `Start a session in ${vault}`;

    const swatch = document.createElement('span');
    swatch.className = 'vault-swatch';
    swatch.style.background = projectColor(vault);
    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = proj.name;
    row.appendChild(swatch);
    row.appendChild(name);

    if (main) {
      const dot = document.createElement('span');
      dot.className = `status-dot ${main.status || 'idle'}`;
      row.appendChild(dot);
    }

    const pendingTotal = projectSessions.reduce((n, s) => n + (s.id !== currentSessionId ? (s.pending_approvals || 0) : 0), 0);
    if (pendingTotal > 0) {
      const badge = document.createElement('span');
      badge.className = 'pending-badge';
      badge.textContent = String(pendingTotal);
      badge.title = `${pendingTotal} approval(s) waiting`;
      row.appendChild(badge);
    }

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'project-add';
    addButton.textContent = '+';
    addButton.setAttribute('aria-label', `New session in ${vault}`);
    addButton.title = `New session in ${vault}`;
    addButton.addEventListener('click', (e) => { e.stopPropagation(); createSession(vault); });
    addButton.addEventListener('keydown', (e) => { e.stopPropagation(); });
    row.appendChild(addButton);

    row.addEventListener('click', () => { if (main) selectSession(main.id); else createSession(vault); });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (main) selectSession(main.id);
        else createSession(vault);
      }
    });

    sessionList.appendChild(row);

    if (projectSessions.length > 1) {
      for (const s of sessions) {
        if (s.project === vault && s.id !== main.id) {
          sessionList.appendChild(sessionItem(s));
        }
      }
    }
  }
}

let lastSessionsJson = '';

async function refreshSessions() {
  const body = await api('/api/sessions');
  sessions = body.sessions;
  // Background sessions keep running; the poll only repaints when something changed.
  const json = JSON.stringify(sessions);
  if (json === lastSessionsJson) return;
  lastSessionsJson = json;
  const waiting = sessions.reduce((n, s) => n + (s.pending_approvals || 0), 0);
  document.title = waiting ? `(${waiting}) Keelvane Harness` : 'Keelvane Harness';
  renderSessionList();
  if (currentSessionId) {
    const session = sessions.find((s) => s.id === currentSessionId);
    if (session) setHeader(session);
  }
}

archiveBtn.addEventListener('click', async () => {
  if (sending) return;
  const session = sessions.find((s) => s.id === currentSessionId);
  if (!session) return;
  if (!confirm(`Archive "${session.title || 'this session'}"? It leaves the sidebar; its history stays on disk.`)) return;
  try {
    await api(`/api/sessions/${session.id}/archive`, { method: 'POST', headers: { 'X-Keelvane-Action': 'confirmed' } });
  } catch (error) {
    alert(`Could not archive: ${error.message}`);
    return;
  }
  if (eventSource) eventSource.close();
  eventSource = null;
  currentSessionId = null;
  resetChatState();
  setHeader(null);
  resetInsights(null);
  attachments.clear();
  gitPanel.setSession(null);
  renderEmptyState();
  await refreshSessions();
  renderSessionList();
});

function resetChatState() {
  chat.innerHTML = '';
  currentAssistantEl = null;
  assistantBuffer = '';
  pendingTools.length = 0;
}

function selectSession(id, checked = false) {
  const known = sessions.find((s) => s.id === id);
  if (!known) return false;
    composerText.value = '';
  currentSessionId = id;
  sidebar.classList.remove('open');
  renderSessionList();
  resetChatState();
  setRunning(false);
  const session = sessions.find((s) => s.id === id);
  if (session) setHeader(session);
  resetInsights(session);
  attachments.clear();
  gitPanel.setSession(id);
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/sessions/${id}/events`);
  eventSource.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data);
      trackEvent(event);
      renderEvent(event);
    } catch {
      /* ignore malformed event */
    }
  };
}

function addMsg(cls, text) {
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.textContent = text;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function ensureAssistantEl() {
  if (!currentAssistantEl) {
    currentAssistantEl = document.createElement('div');
    currentAssistantEl.className = 'msg assistant';
    chat.appendChild(currentAssistantEl);
    assistantBuffer = '';
  }
  return currentAssistantEl;
}

function renderDiff(pre, diffText) {
  pre.textContent = '';
  const lines = diffText.split('\n');
  for (const line of lines) {
    const span = document.createElement('span');
    span.textContent = line;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      span.className = 'diff-add';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      span.className = 'diff-del';
    } else if (line.startsWith('@@')) {
      span.className = 'diff-hunk';
    }
    pre.appendChild(span);
  }
}

function renderApprovalCard(payload) {
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.dataset.approvalId = payload.approval_id;

  const title = document.createElement('div');
  title.className = 'approval-title';
  const icon = document.createElement('span');
  icon.className = 'approval-icon';
  icon.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1l6 2v5c0 4-2.5 6.5-6 8-3.5-1.5-6-4-6-8V3z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  const text = document.createElement('span');
  text.textContent = `${payload.tool} needs approval`;
  title.appendChild(icon);
  title.appendChild(text);
  card.appendChild(title);

  const reason = document.createElement('div');
  reason.className = 'approval-reason';
  reason.textContent = payload.reason || '';
  card.appendChild(reason);

  // The resolved path, in full: a long ..\ path can look like it stays in the project.
  if (payload.target) {
    const target = document.createElement('div');
    target.className = 'approval-target';
    target.textContent = payload.target;
    card.appendChild(target);
  }

  if (payload.preview) {
    const pre = document.createElement('pre');
    pre.className = 'approval-preview';
    if (payload.preview.startsWith('--- ')) {
      renderDiff(pre, payload.preview);
    } else {
      pre.textContent = payload.preview;
    }
    card.appendChild(pre);
  }

  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const approveBtn = document.createElement('button');
  approveBtn.className = 'approve-btn';
  approveBtn.textContent = 'Approve';
  approveBtn.addEventListener('click', () => resolveApproval(card, payload.approval_id, 'approve'));
  const denyBtn = document.createElement('button');
  denyBtn.className = 'deny-btn';
  denyBtn.textContent = 'Deny';
  denyBtn.addEventListener('click', () => resolveApproval(card, payload.approval_id, 'deny'));
  actions.appendChild(approveBtn);
  actions.appendChild(denyBtn);
  card.appendChild(actions);

  chat.appendChild(card);
  chat.scrollTop = chat.scrollHeight;
}

async function resolveApproval(card, approvalId, decision) {
  try {
    await api(`/api/sessions/${currentSessionId}/approvals/${approvalId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Keelvane-Action': 'confirmed' },
      body: JSON.stringify({ decision }),
    });
  } catch (error) {
    if (error.status === 404) markApprovalResolved(card, 'expired');
  }
}

const APPROVAL_OUTCOMES = { approve: 'approved', deny: 'denied', expired: 'expired' };

function markApprovalResolved(card, decision) {
  if (card.querySelector('.approval-outcome')) return;
  for (const btn of card.querySelectorAll('button')) btn.disabled = true;
  const outcome = document.createElement('div');
  outcome.className = 'approval-outcome';
  outcome.textContent = APPROVAL_OUTCOMES[decision] || decision;
  card.appendChild(outcome);
}

function primaryArg(args) {
  if (!args) return '';
  const value = args.path || args.command || args.pattern || args.instructions || '';
  return String(value).slice(0, 80);
}

function renderToolCard(payload) {
  const details = document.createElement('details');
  details.className = `tool-card running cat-${toolCategory(payload.tool)}`;
  const summary = document.createElement('summary');

  const icon = document.createElement('span');
  icon.className = 'tool-icon';
  icon.innerHTML = toolIcon(payload.tool);

  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = payload.tool;

  const arg = document.createElement('span');
  arg.className = 'tool-arg';
  arg.textContent = primaryArg(payload.args);

  const stats = document.createElement('span');
  stats.className = 'tool-stats';

  const state = document.createElement('span');
  state.className = 'tool-state running';

  summary.appendChild(icon);
  summary.appendChild(name);
  summary.appendChild(arg);
  summary.appendChild(stats);
  summary.appendChild(state);

  const pre = document.createElement('pre');
  pre.textContent = 'running...';
  details.appendChild(summary);
  details.appendChild(pre);
  chat.appendChild(details);
  chat.scrollTop = chat.scrollHeight;
  pendingTools.push({ details, summary, pre, stats, state });
  currentAssistantEl = null;
  assistantBuffer = '';
}

function renderEvent(event) {
  const { type, payload } = event;

  if (type === 'user_message') {
    const bubble = addMsg('user', payload.text);
    const chipTexts = [
      ...(payload.skill ? [['skill', `/${payload.skill}`]] : []),
      ...(payload.attachments || []).map((a) => ['file', a.name]),
    ];
    if (chipTexts.length) {
      const chips = document.createElement('div');
      chips.className = 'msg-chips';
      for (const [kind, label] of chipTexts) {
        const chip = document.createElement('span');
        chip.className = `msg-chip ${kind}`;
        chip.textContent = label;
        chips.appendChild(chip);
      }
      bubble.prepend(chips);
    }
    currentAssistantEl = null;
    assistantBuffer = '';
    setRunning(true);
    refreshSessions().catch(() => {});
  } else if (type === 'text_delta') {
    const el = ensureAssistantEl();
    assistantBuffer += payload.text;
    el.innerHTML = marked.parse(assistantBuffer);
    chat.scrollTop = chat.scrollHeight;
  } else if (type === 'tool_started') {
    renderToolCard(payload);
  } else if (type === 'tool_finished') {
    const entry = pendingTools.shift();
    if (entry) {
      entry.details.classList.remove('running');
      entry.details.classList.add(payload.ok ? 'ok' : 'error');
      entry.state.className = `tool-state ${payload.ok ? 'ok' : 'error'}`;
      if (payload.diff) {
        renderDiff(entry.pre, payload.diff);
        const stats = diffStats(payload.diff);
        if (stats.add > 0) {
          const addBadge = document.createElement('span');
          addBadge.className = 'badge add';
          addBadge.textContent = `+${stats.add}`;
          entry.stats.appendChild(addBadge);
        }
        if (stats.del > 0) {
          const delBadge = document.createElement('span');
          delBadge.className = 'badge del';
          delBadge.textContent = `-${stats.del}`;
          entry.stats.appendChild(delBadge);
        }
      } else {
        entry.pre.textContent = payload.ok ? (payload.result || '(empty result)') : `error: ${payload.error}`;
      }
    }
  } else if (type === 'approval_requested') {
    renderApprovalCard(payload);
    currentAssistantEl = null;
    assistantBuffer = '';
  } else if (type === 'approval_resolved') {
    const card = chat.querySelector(`.approval-card[data-approval-id="${payload.approval_id}"]`);
    if (card) markApprovalResolved(card, payload.decision);
  } else if (type === 'turn_finished') {
    currentAssistantEl = null;
    assistantBuffer = '';
    setRunning(false);
    setStatus('idle', 'idle');
    refreshSessions().catch(() => {});
    // Replayed history fires many turn_finished events at once; refresh git once after them.
    clearTimeout(gitRefreshTimer);
    gitRefreshTimer = setTimeout(() => gitPanel.refresh(), 400);
  } else if (type === 'error') {
    addMsg('error', payload.message === 'success' ? 'This turn failed. Its original error details were not retained. Resend your request to see the current result.' : (payload.message || 'engine error'));
    currentAssistantEl = null;
    setRunning(false);
    setStatus('error', 'error');
    refreshSessions().catch(() => {});
  }
}

let gitRefreshTimer = null;
const gitBadge = document.getElementById('gitBadge');
const gitPanel = initGitPanel({
  container: document.getElementById('gitPane'),
  renderDiff,
  onCount: (n) => { gitBadge.textContent = n > 0 ? String(n) : ''; },
});
const attachments = initAttachments({
  button: document.getElementById('attachBtn'),
  input: document.getElementById('fileInput'),
  dropZone: composerForm,
  textarea: composerText,
  row: document.getElementById('attachRow'),
  getSessionId: () => currentSessionId,
  onError: (message) => addMsg('error', message),
});
// Registers a capture-phase keydown on the form, so an open menu sees Enter before the handler below.
initSkillsMenu({ textarea: composerText, container: composerForm });

for (const tab of document.querySelectorAll('.insights-tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.insights-tab')) {
      other.classList.toggle('active', other === tab);
      other.setAttribute('aria-selected', String(other === tab));
    }
    document.getElementById('insightsPane').hidden = tab.dataset.tab !== 'insights';
    document.getElementById('gitPane').hidden = tab.dataset.tab !== 'git';
    if (tab.dataset.tab === 'git') gitPanel.refresh();
  });
}

composerText.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    composerForm.requestSubmit();
  }
});

composerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (sending || running) return;
  if (!currentSessionId) return alert('Start a session first.');
  const destinationSessionId = currentSessionId;
  if (attachments.isBusy()) return addMsg('error', 'Wait for uploads to finish before sending.');
  const raw = composerText.value.trim();
  const files = attachments.getAttachments();
  if (!raw && !files.length) return;
  let body = { text: raw };
  // "/name rest" invokes a known skill; any other leading slash is sent as plain text.
  const m = /^\/([A-Za-z0-9][\w.-]*)(?:\s+([\s\S]*))?$/.exec(raw);
  if (m && findSkill(m[1])) {
    body.skill = findSkill(m[1]).name;
    body.text = (m[2] || '').trim();
  }
  if (files.length) body.attachments = files.map(({ name, path }) => ({ name, path }));
  sending = true;
  sendBtn.disabled = true;
  composerText.value = '';
  try {
    await api(`/api/sessions/${destinationSessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Keelvane-Action': 'confirmed' },
      body: JSON.stringify(body),
    });
    attachments.clear();
  } catch (error) {
    composerText.value = raw;
    addMsg('error', `send failed: ${error.message}`);
  } finally {
    sending = false;
    sendBtn.disabled = running;
  }
});

stopBtn.addEventListener('click', async () => {
  if (!currentSessionId) return;
  try {
    await api(`/api/sessions/${currentSessionId}/stop`, {
      method: 'POST',
      headers: { 'X-Keelvane-Action': 'confirmed' },
    });
  } catch (error) {
    addMsg('error', `stop failed: ${error.message}`);
  }
});

function renderEmptyState() {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  const mark = document.createElement('div');
  mark.className = 'empty-mark';
  mark.innerHTML = '<svg viewBox="0 0 32 32" width="72" height="72" aria-hidden="true"><rect class="slab" x="2" y="4" width="5" height="24" rx="2"/><rect class="slab" x="10" y="4" width="5" height="24" rx="2"/><rect class="slab accent" x="18" y="4" width="5" height="24" rx="2"/><rect class="slab" x="26" y="4" width="5" height="24" rx="2"/></svg>';
  const heading = document.createElement('h2');
  heading.textContent = 'Pick a session or start a new one';
  const tips = document.createElement('ul');
  tips.className = 'empty-tips';
  const tipTexts = [
    'Reads inside the project run freely; anything outside asks first',
    'Every write shows a diff; protected paths are refused',
    'Commands always ask you first',
  ];
  for (const tip of tipTexts) {
    const li = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'tip-icon';
    icon.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    const span = document.createElement('span');
    span.textContent = tip;
    li.appendChild(icon);
    li.appendChild(span);
    tips.appendChild(li);
  }
  empty.appendChild(mark);
  empty.appendChild(heading);
  empty.appendChild(tips);
  chat.appendChild(empty);
}

function initInsightsVisibility() {
  try {
    const stored = localStorage.getItem('keelvane.insightsHidden');
    if (stored === 'true') {
      app.classList.add('insights-hidden');
    } else if (stored === 'false') {
      app.classList.remove('insights-hidden');
    } else if (window.innerWidth < 1100) {
      app.classList.add('insights-hidden');
    }
  } catch {
    if (window.innerWidth < 1100) app.classList.add('insights-hidden');
  }
}

insightsToggle.addEventListener('click', () => {
  app.classList.toggle('insights-hidden');
  try {
    localStorage.setItem('keelvane.insightsHidden', app.classList.contains('insights-hidden') ? 'true' : 'false');
  } catch {
    /* storage may throw */
  }
});

initInsightsVisibility();
resetInsights(null);
renderEmptyState();
// Parallel sessions: keep status dots and approval badges for background sessions current.
setInterval(() => refreshSessions().catch(() => {}), 4000);
api('/api/projects').then((body) => { PROJECTS = body.projects; renderSessionList(); }).catch(() => {});
refreshSessions().catch((error) => {
  chat.innerHTML = '';
  const err = document.createElement('div');
  err.className = 'msg error';
  err.textContent = `Could not load sessions: ${error.message}`;
  chat.appendChild(err);
});
