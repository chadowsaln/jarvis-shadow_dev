// The approval dialog's logic, apart from the DOM: what it shows, when it may be answered, and what it sends back.
//
// The sidecar owns the pending action (id, tool, normalized arguments, fingerprint, expiry). This side only
// repeats back the request it was shown: the same id, the same fingerprint, one answer. Anything the sidecar
// does not recognise - a stale id, a second answer, an expired request - is refused there, and the tool never
// runs. Nothing here can grant a permission or remember a yes: every request is asked again on its own.

const PERMISSION_WORDS = { observe: 'Observe', assist: 'Assist', trusted: 'Trusted', sensitive: 'Sensitive', administrative: 'Administrative' };
const RISK_WORDS = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical', unknown: 'Unknown' };

// The line the dialog ends on, once it has been answered or taken away.
export const DECISION_TEXT = {
  approved: 'Approved. Doing it now.',
  rejected: 'Rejected. Nothing happens.',
  expired: 'Ran out of time. Nothing happens.',
  cancelled: 'Cancelled. Nothing happens.',
  mismatch: 'That answer did not match the request. Nothing happens.',
  unknown: 'That request is no longer waiting. Nothing happens.',
  failed: 'The answer did not get through. Nothing happens.',
};

const MAX_ARG_LINES = 6;

/**
 * A request from the sidecar, or null if it cannot be answered.
 * Refusing an unusable one is the safe direction: the sidecar's own timer denies it either way.
 */
export function parseRequest(request) {
  if (!request || typeof request !== 'object') return null;
  const id = typeof request.id === 'string' ? request.id.trim() : '';
  const tool = typeof request.tool === 'string' ? request.tool.trim() : '';
  if (!id || !tool || !Number.isFinite(Number(request.expiresAt))) return null;
  const level = typeof request.permissionLevel === 'string' ? request.permissionLevel.toLowerCase() : '';
  const risk = typeof request.risk === 'string' ? request.risk.toLowerCase() : '';
  return {
    id,
    tool,
    // Opaque here: shown nowhere, repeated back so the answer is bound to the exact action.
    fingerprint: typeof request.fingerprint === 'string' ? request.fingerprint : '',
    args: request.args ?? null,
    reason: typeof request.reason === 'string' ? request.reason : '',
    description: typeof request.detail === 'string' ? request.detail : '',
    permissionLevel: PERMISSION_WORDS[level] ? level : null,
    risk: RISK_WORDS[risk] ? risk : 'unknown',
    expiresAt: Number(request.expiresAt),
  };
}

/** "0:47" left, never below zero: the dialog counts down and stops, it never extends. */
export function formatLeft(ms) {
  const s = Math.max(0, Math.ceil(Number(ms) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The arguments as short lines. The sidecar has already masked secrets and clipped long values. */
export function argLines(args) {
  if (args == null) return [];
  if (typeof args !== 'object') return [{ key: '', value: String(args) }];
  const rows = Array.isArray(args) ? args.map((v, i) => ({ key: String(i), value: show(v) })) : Object.entries(args).map(([k, v]) => ({ key: k, value: show(v) }));
  return rows.length ? rows.slice(0, MAX_ARG_LINES) : [];
}

function show(v) {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * What the dialog draws for one request at `now`. canAnswer: the request is still live and has not been
 * answered here; after that the buttons stay dead, so a double press can never send two answers.
 */
export function viewOf(request, now = Date.now(), { decision = null, closed = null } = {}) {
  const parsed = parseRequest(request);
  if (!parsed) return null;
  const left = parsed.expiresAt - Number(now);
  const expired = closed === 'expired' || (closed == null && left <= 0);
  const lines = argLines(parsed.args);
  return {
    id: parsed.id,
    tool: parsed.tool,
    operation: parsed.description || parsed.reason || '',
    reason: parsed.reason,
    permissionLevel: parsed.permissionLevel,
    permissionLabel: parsed.permissionLevel ? PERMISSION_WORDS[parsed.permissionLevel] : 'Unstated',
    risk: parsed.risk,
    riskLabel: RISK_WORDS[parsed.risk],
    args: lines,
    argsText: lines.map((l) => (l.key ? `${l.key}: ${l.value}` : l.value)),
    left,
    leftLabel: formatLeft(left),
    expired,
    // Answered here (sent), taken away by the sidecar (closed), or run out of time: no more answers.
    done: !!(decision || closed || expired),
    canAnswer: !decision && !closed && !expired,
    closing: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : closed,
  };
}

/**
 * The one message the panel sends for a request, or null when it may not answer (already answered, expired,
 * or the request never parsed). decision is 'approve' or 'reject'.
 */
export function answerFor(request, decision, now = Date.now()) {
  const parsed = parseRequest(request);
  if (!parsed) return null;
  if (decision !== 'approve' && decision !== 'reject') return null;
  if (parsed.expiresAt <= Number(now)) return null;
  return {
    type: 'agentcore_approval',
    id: parsed.id,
    decision,
    // The panel repeats what it was shown, so the sidecar can tell this answer belongs to that exact action.
    toolName: parsed.tool,
    ...(parsed.fingerprint ? { fingerprint: parsed.fingerprint } : {}),
  };
}

/** What came back for a dialog that was taken away (kind 'approval_closed'), in the words the dialog ends on. */
export function closedWord(msg) {
  const why = String(msg?.why ?? '').toLowerCase();
  return Object.hasOwn(DECISION_TEXT, why) ? why : 'unknown';
}
