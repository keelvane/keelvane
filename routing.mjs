// Ported from a private routing module (2026-10-26); unknown usage uses a neutral ranking prior.
// Pure route selection: usage telemetry in, one eligible route out. No I/O, no dependencies.

export const UNKNOWN_COST_PRIOR = 0.5;
const DEFAULTS = { lowThreshold: 0.15, lowPenalty: 0.6, staleMs: 15 * 60000 };
const LEGACY_WINDOWS = { rolling: 24 * 60, week: 7 * 24 * 60 };

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const opt = (o) => ({ ...DEFAULTS, ...o });

function windowsOf(p) {
  if (Array.isArray(p?.windows)) {
    return p.windows.filter((w) => w && typeof w === 'object' && (w.windowMinutes != null || w.durationMinutes != null || w.remainingPercent != null || w.resetsAt != null))
      .map((w) => ({ remainingPercent: w.remainingPercent, resetsAt: w.resetsAt, minutes: w.windowMinutes ?? w.durationMinutes }));
  }
  return Object.entries(LEGACY_WINDOWS).filter(([k]) => p?.[k]).map(([k, minutes]) => ({ remainingPercent: p[k].remainingPercent, resetsAt: p[k].resetsAt, minutes }));
}

export function usageCapacity(provider, now = Date.now(), options) {
  const { lowThreshold, staleMs } = opt(options);
  const observed = Date.parse(provider?.observedAt);
  if (!Number.isFinite(observed) || observed - now > 60000) return 'unknown';
  if (provider?.ordinaryUsageAllowed === false) return now - observed > staleMs ? 'unknown' : 'exhausted';
  const ws = windowsOf(provider);
  if (ws.some((w) => w.remainingPercent === 0 && Date.parse(w.resetsAt) > now)) return 'exhausted';
  if (provider?.available !== true || provider.stale === true || now - observed > staleMs || !ws.length) return 'unknown';
  const bad = ws.some((w) => typeof w.remainingPercent !== 'number' || !Number.isFinite(w.remainingPercent) || w.remainingPercent < 0 || w.remainingPercent > 100
    || !(Date.parse(w.resetsAt) > now) || !Number.isFinite(w.minutes) || w.minutes <= 0);
  if (bad) return 'unknown';
  return Math.min(...ws.map((w) => w.remainingPercent)) < lowThreshold * 100 ? 'low' : 'available';
}

// score = 0.75 headroom + 0.20 recovery + 0.05 freshness; null whenever usage is unknown or exhausted.
export function normalizeUsage(provider, now = Date.now(), options) {
  const state = usageCapacity(provider, now, options);
  const empty = { state, remainingPercent: null, resetsAt: null, observedAt: null, score: null, components: { headroom: null, recovery: null, freshness: null } };
  if (state === 'unknown') return empty;
  const { staleMs } = opt(options);
  const observed = Date.parse(provider.observedAt);
  const freshness = 1 - Math.min(Math.max(0, now - observed), staleMs) / staleMs;
  const ws = windowsOf(provider);
  const observedAt = new Date(observed).toISOString();
  if (state === 'exhausted') {
    return { ...empty, remainingPercent: 0, resetsAt: ws.find((w) => w.remainingPercent === 0)?.resetsAt ?? null, observedAt, components: { ...empty.components, freshness } };
  }
  const remainingPercent = Math.min(...ws.map((w) => w.remainingPercent));
  const recovery = ws.reduce((s, w) => s + 1 - Math.min(Date.parse(w.resetsAt) - now, w.minutes * 60000) / (w.minutes * 60000), 0) / ws.length;
  const headroom = remainingPercent / 100;
  return { state, remainingPercent, resetsAt: ws.map((w) => w.resetsAt), observedAt, score: 0.75 * headroom + 0.2 * recovery + 0.05 * freshness, components: { headroom, recovery, freshness } };
}

// -Infinity when a required capability is missing; otherwise a small additive fit.
export function taskFit(task, candidate, { preferred = null, role = 'manager', requiredCapabilities = [] } = {}) {
  const caps = new Set(candidate.capabilities || []);
  if (requiredCapabilities.some((c) => !caps.has(c))) return -Infinity;
  const text = String(task?.text ?? task?.description ?? '').toLowerCase();
  let fit = 0;
  if ((candidate.roles || []).includes(role)) fit += 0.05;
  if (preferred != null && preferred === candidate.family) fit += 0.2;
  if (/image|photo|visual|video/.test(text) && caps.has('images')) fit += 0.15;
  if (/document|pdf|spreadsheet|report/.test(text) && caps.has('documents')) fit += 0.1;
  if (['high-level', 'escalation'].includes(candidate.mode)) fit += /architecture|complex|comprehensive|multi-step|high stakes|formal review|escalat/.test(text) ? 0.1 : -0.05;
  return fit;
}

// catalog entries become managers, workers[family] entries (string or object) become workers; duplicates merge.
export function buildNativePool({ catalog = [], workers = {}, allowedFamilies } = {}) {
  const allowed = allowedFamilies ? new Set(allowedFamilies) : null;
  const pool = [];
  const seen = new Map();
  const add = (c) => {
    if (!c.family || !String(c.model || '').trim() || c.available === false || c.accessible === false || (allowed && !allowed.has(c.family))) return;
    const key = c.routeId ? `route:${c.routeId}` : `${c.family}:${String(c.model).trim()}`;
    const availability = c.available === true || c.accessible === true ? 'verified' : 'configured_unverified';
    const prior = seen.get(key);
    if (prior) {
      prior.roles = [...new Set([...prior.roles, c.role])];
      prior.capabilities = [...new Set([...prior.capabilities, ...(c.capabilities || ['text'])])];
      if (availability === 'verified') prior.availability = 'verified';
      return;
    }
    const { role, available, accessible, ...rest } = c;
    const entry = { ...rest, model: String(c.model).trim(), roles: [role], capabilities: c.capabilities || ['text'], availability };
    seen.set(key, entry);
    pool.push(entry);
  };
  for (const item of catalog) add({ ...item, role: 'manager' });
  for (const [family, configured] of Object.entries(workers)) {
    for (const e of Array.isArray(configured) ? configured : configured ? [configured] : []) {
      add({ family, ...(typeof e === 'string' ? { model: e } : e), role: 'worker' });
    }
  }
  return pool;
}

function usageFor(usage, c, now, options) {
  if (c.accountId) return normalizeUsage(usage?.accounts?.[c.accountId], now, options);
  if (c.routeId && usage?.routes?.[c.routeId]) return normalizeUsage(usage.routes[c.routeId], now, options);
  return normalizeUsage(c.routeId ? undefined : usage?.[c.family], now, options);
}

// Ranking: routeCost (unknown = UNKNOWN_COST_PRIOR), then usage score, then bounded task fit, then route id.
// An optional decide(request) may return { routeId } (or { decision: { routeId } }); honored only if eligible.
export async function selectNativeRoute(task, { usage = {}, pool = [], decide, isPrivate = false, now = Date.now(), allowedFamilies, preferredFamily = null, role = 'manager', requiredCapabilities = [], ...tuning } = {}) {
  const { lowThreshold, lowPenalty } = opt(tuning);
  const candidates = pool.filter((c) => (!allowedFamilies || allowedFamilies.includes(c.family)) && c.available !== false && c.accessible !== false && (c.roles || []).includes(role));
  const scored = candidates.map((c) => {
    const telemetry = usageFor(usage, c, now, tuning);
    const fit = taskFit(task, c, { preferred: preferredFamily, role, requiredCapabilities });
    const known = telemetry.state !== 'unknown';
    const penalty = known && telemetry.remainingPercent < lowThreshold * 100 ? lowPenalty : 0;
    const cost = known ? 1 - telemetry.remainingPercent / 100 + penalty : null;
    return { ...c, fit, usage: telemetry, routeCost: cost, rankCost: cost ?? UNKNOWN_COST_PRIOR, rankScore: known ? telemetry.score - penalty : -Infinity, boundedFit: clamp(fit * 0.2, -0.1, 0.2) };
  }).filter((c) => Number.isFinite(c.fit) && c.usage.state !== 'exhausted');
  if (!scored.length) return { routeId: null, source: 'policy', reason: candidates.length ? 'capacity_or_capability_blocked' : 'no_configured_candidate', role };

  const key = (c) => `${c.routeId ?? ''}|${c.family}:${c.model}`;
  scored.sort((a, b) => a.rankCost - b.rankCost || b.rankScore - a.rankScore || b.boundedFit - a.boundedFit || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  let chosen = scored[0];
  let source = 'policy';
  let reason = 'lowest_route_cost';
  if (decide && !isPrivate) {
    try {
      const result = await decide({
        task, role,
        candidates: scored.map((c) => ({ routeId: c.routeId, family: c.family, model: c.model, remainingPercent: c.usage.remainingPercent, routeCost: c.routeCost, availability: c.availability, capabilities: c.capabilities })),
      });
      const id = result?.routeId ?? result?.decision?.routeId;
      const picked = typeof id === 'string' ? scored.find((c) => c.routeId === id) : null;
      if (picked) { chosen = picked; source = 'decide'; reason = 'decide_route_selection'; }
      else { source = 'policy_fallback'; reason = 'decide_route_invalid_or_ineligible'; }
    } catch {
      source = 'policy_fallback'; reason = 'decide_unavailable';
    }
  }
  const { rankCost, rankScore, boundedFit, ...route } = chosen;
  return { ...route, role, source, reason, score: chosen.usage.score };
}
