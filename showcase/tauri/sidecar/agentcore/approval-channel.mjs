// Approval channel: the transport between the agent core's executor and the real panel window.
//
// The sidecar owns the pending action and everything that authorizes it: a unique request id, the exact
// tool name, the exact normalized arguments, the action fingerprint, an expiry, and single-use consumption.
// The panel may only approve or reject the exact request it was shown, by id and fingerprint, once.
// Anything else - unknown id, stale id, duplicate answer, mismatched tool or fingerprint, expired request,
// cancelled run, a closed panel, a missing or broken channel - denies execution. Closing never approves.

import { fingerprintAction, normalizePermissionLevel, PERMISSION_LEVEL_ORDER } from './permissions.mjs';

const SECRET_KEY = /(^|_|\b)(api[-_]?key|apikey|key|token|secret|password|passwd|pass|auth|authorization|cookie|credential|session|bearer|pin)(_|s|\b|-)/i;
const MAX_STRING = 240;
const MAX_ITEMS = 8;
const MAX_DEPTH = 3;

/**
 * What the dialog may show: secrets masked, strings clipped, depth and list length capped.
 * Never the raw arguments, so a key pasted into a tool call cannot be displayed.
 */
export function sanitizeArgs(args, depth = 0) {
  if (args == null) return null;
  if (typeof args === 'string') return args.length > MAX_STRING ? `${args.slice(0, MAX_STRING)}…` : args;
  if (typeof args === 'number' || typeof args === 'boolean') return args;
  if (typeof args !== 'object') return String(args).slice(0, MAX_STRING);
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(args)) {
    const shown = args.slice(0, MAX_ITEMS).map((v) => sanitizeArgs(v, depth + 1));
    if (args.length > MAX_ITEMS) shown.push(`… ${args.length - MAX_ITEMS} more`);
    return shown;
  }
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = SECRET_KEY.test(k) ? '[hidden]' : sanitizeArgs(v, depth + 1);
  }
  return out;
}

/** How a call is presented to the person approving it. */
export function riskOf(level) {
  const rank = PERMISSION_LEVEL_ORDER[normalizePermissionLevel(level)] ?? null;
  if (rank == null) return 'unknown';
  if (rank <= 1) return 'low';
  if (rank === 2) return 'medium';
  if (rank === 3) return 'high';
  return 'critical';
}

const DENY = (reason, extra = {}) => ({ approved: false, reason, ...extra });

export function createApprovalChannel({
  send,                       // ({type,...}) => void, the sidecar's stdout writer
  showPanel = null,           // () => void, brings the panel up so the dialog is visible
  ttlMs = 60_000,
  now = () => Date.now(),
  maxPending = 4,
  logger = null,
} = {}) {
  const pending = new Map();
  const canonical = new Map(); // fingerprint+tool+args -> id, so one action never gets two live dialogs
  let channelBroken = false;

  const log = (type, data = {}) => { try { logger?.({ type, ...data }); } catch {} };

  function emit(msg) {
    if (!send) return false;
    try { send(msg); return true; } catch { return false; }
  }

  /** The message the panel renders. Everything the dialog shows comes from the sidecar's own copy. */
  function dialogMessage(entry) {
    return {
      type: 'panel',
      msg: {
        kind: 'approval',
        request: {
          id: entry.id,
          tool: entry.toolName,
          // Opaque: the panel never shows it, and repeats it back so the answer cannot be aimed at another action.
          fingerprint: entry.fingerprint,
          args: entry.displayArgs,
          detail: entry.detail,
          risk: entry.risk,
          permissionLevel: entry.permissionLevel,
          reason: entry.reason,
          expiresAt: entry.expiresAt,
          ttlMs: Math.max(1, entry.expiresAt - now()),
          stepId: entry.stepId,
        },
      },
    };
  }

  function settle(entry, response) {
    if (entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    pending.delete(entry.id);
    canonical.delete(entry.canonicalKey);
    try { entry.resolve(response); } catch {}
    return true;
  }

  /**
   * Called by the executor for one step. Resolves with an approval response the executor still
   * verifies and consumes against its own store.
   */
  function request({ request, step = null, plan = null, tool = null, args = null, route = null } = {}) {
    const id = String(request?.id ?? '');
    const toolName = String(request?.toolName ?? '');
    if (!id || !toolName) return Promise.resolve(DENY('approval request is missing its id or tool'));
    if (channelBroken) return Promise.resolve(DENY('approval channel unavailable'));
    if (!send) return Promise.resolve(DENY('approval channel unavailable'));
    if (pending.size >= maxPending) return Promise.resolve(DENY('too many approvals waiting'));

    const appliedArgs = args ?? request?.args ?? {};
    const fingerprint = String(request?.fingerprint ?? fingerprintAction(request?.toolName, appliedArgs, null));
    const permissionLevel = normalizePermissionLevel(request?.permissionLevel);
    const canonicalKey = `${toolName}:${fingerprint}`;
    // The same action, unchanged, already on screen: reuse that dialog instead of stacking a second one.
    if (canonical.has(canonicalKey)) return Promise.resolve(DENY('approval already pending for this action'));

    // The dialog never outlives either clock: the executor's request has its own expiry, and the channel has its
    // own ceiling. Whichever comes first, an unanswered dialog denies.
    const expiresAt = Math.min(Number(request?.expiresAt) || Infinity, now() + Math.max(1, Number(ttlMs) || 60_000));

    return new Promise((resolve) => {
      const entry = {
        id, toolName, fingerprint, permissionLevel,
        args: appliedArgs,
        displayArgs: sanitizeArgs(appliedArgs),
        // The tool's own description of what it does, in the words its permission metadata carries.
        detail: String(tool?.permission?.description ?? route?.permissionMeta?.description ?? ''),
        risk: riskOf(permissionLevel),
        reason: String(request?.reason ?? ''),
        stepId: step?.id ?? request?.stepId ?? null,
        planId: plan?.id ?? null,
        expiresAt,
        canonicalKey,
        settled: false,
        resolve,
        timer: null,
        route,
        requestedAt: now(),
      };
      pending.set(id, entry);
      canonical.set(canonicalKey, id);
      // Expiry is the channel's own clock: an unanswered dialog denies, it never waits forever.
      entry.timer = setTimeout(() => {
        if (entry.settled) return;
        const expired = now() >= entry.expiresAt;
        log('approval_expired', { id, tool: toolName, expired });
        if (settle(entry, DENY('approval timed out', { timeout: true, requestId: id }))) {
          emit({ type: 'panel', msg: { kind: 'approval_closed', id, why: 'expired' } });
        }
      }, Math.max(1, expiresAt - now()));
      entry.timer.unref?.();

      if (!emit(dialogMessage(entry))) {
        settle(entry, DENY('approval channel unavailable', { requestId: id }));
        return;
      }
      log('approval_shown', { id, tool: toolName, risk: entry.risk, expiresAt });
      try { showPanel?.(); } catch { /* the dialog is also in the panel already */ }
    });
  }

  /**
   * The dialogs still waiting, shown again: the panel is a fresh page each time it opens, so a request
   * that arrived while it was closed has to be sent again. Same ids, same fingerprints, same clocks -
   * only the rendering is repeated, and an answer still goes through answer() like any other.
   */
  function resend() {
    let shown = 0;
    for (const entry of pending.values()) {
      if (entry.settled) continue;
      if (emit(dialogMessage(entry))) shown++;
    }
    if (shown) log('approval_reshown', { count: shown });
    return shown;
  }

  /**
   * One answer from the panel (already parsed from the protocol). Approves only the exact request
   * shown: same id, same tool, same fingerprint, not settled, not expired, approve or reject.
   */
  function answer(msg) {
    // A malformed answer (null, a string, a message with no id) is refused, never thrown: stdin is not trusted
    // to be well formed, and a throw here would be an answer nobody handled.
    msg = msg && typeof msg === 'object' ? msg : {};
    const id = String(msg.id ?? '');
    const decision = String(msg.decision ?? '').toLowerCase();

    // The panel may say the whole dialog went away without a decision (Esc, window closed).
    if (msg.kind === 'closed' || decision === 'closed' || decision === 'cancel') {
      const entry = pending.get(id);
      if (!entry) return { ok: false, reason: 'unknown approval request' };
      settle(entry, DENY('approval dialog closed', { requestId: id }));
      log('approval_cancelled', { id });
      return { ok: true, decision: 'closed' };
    }

    const entry = pending.get(id);
    if (!entry) {
      log('approval_rejected', { id, why: 'unknown or already answered' });
      emit({ type: 'panel', msg: { kind: 'approval_closed', id, why: 'unknown', stale: true } });
      return { ok: false, reason: 'unknown approval request' };
    }
    if (entry.settled) return { ok: false, reason: 'approval already answered' };

    if (msg.toolName != null && String(msg.toolName) !== entry.toolName) {
      settle(entry, DENY('approval response tool mismatch', { requestId: id }));
      emit({ type: 'panel', msg: { kind: 'approval_closed', id, why: 'mismatch' } });
      log('approval_rejected', { id, why: 'tool mismatch' });
      return { ok: false, reason: 'approval response tool mismatch' };
    }
    if (msg.fingerprint != null && String(msg.fingerprint) !== entry.fingerprint) {
      settle(entry, DENY('approval response fingerprint mismatch', { requestId: id }));
      emit({ type: 'panel', msg: { kind: 'approval_closed', id, why: 'mismatch' } });
      log('approval_rejected', { id, why: 'fingerprint mismatch' });
      return { ok: false, reason: 'approval response fingerprint mismatch' };
    }
    if (now() > entry.expiresAt) {
      settle(entry, DENY('approval expired', { requestId: id, expired: true }));
      emit({ type: 'panel', msg: { kind: 'approval_closed', id, why: 'expired' } });
      return { ok: false, reason: 'approval expired' };
    }

    if (decision === 'approve' || decision === 'approved' || decision === 'allow') {
      const ok = settle(entry, {
        approved: true,
        requestId: id,
        fingerprint: entry.fingerprint,
        toolName: entry.toolName,
      });
      if (!ok) return { ok: false, reason: 'approval already answered' };
      log('approval_granted', { id, tool: entry.toolName });
      emit({ type: 'panel', msg: { kind: 'approval_closed', id, why: 'approved' } });
      return { ok: true, decision: 'approved' };
    }
    if (decision === 'reject' || decision === 'rejected' || decision === 'deny') {
      const ok = settle(entry, DENY('the user rejected it', { requestId: id, rejected: true }));
      if (!ok) return { ok: false, reason: 'approval already answered' };
      log('approval_denied', { id, tool: entry.toolName, why: 'rejected' });
      emit({ type: 'panel', msg: { kind: 'approval_closed', id, why: 'rejected' } });
      return { ok: true, decision: 'rejected' };
    }

    settle(entry, DENY('unrecognized approval answer', { requestId: id }));
    emit({ type: 'panel', msg: { kind: 'approval_closed', id, why: 'unknown' } });
    return { ok: false, reason: 'unrecognized approval answer' };
  }

  /** Every waiting dialog denies. Used when the run is cancelled, the panel closes, or the app quits. */
  function denyAll(reason = 'approval cancelled') {
    const ids = [...pending.keys()];
    for (const id of ids) {
      const entry = pending.get(id);
      if (!entry) continue;
      settle(entry, DENY(reason, { requestId: id, cancelled: true }));
      emit({ type: 'panel', msg: { kind: 'approval_closed', id, why: 'cancelled' } });
      log('approval_denied', { id, tool: entry.toolName, why: reason });
    }
    return ids.length;
  }

  /** The transport itself failed (stdout write, panel eval): nothing may execute from here on. */
  function fail(reason = 'approval channel unavailable') {
    channelBroken = true;
    denyAll(reason);
    log('approval_channel_failed', { reason });
  }

  return {
    request,
    answer,
    resend,
    denyAll,
    fail,
    pending() { return [...pending.values()].map((e) => ({ id: e.id, tool: e.toolName, risk: e.risk, expiresAt: e.expiresAt })); },
    pendingCount() { return pending.size; },
    isBroken() { return channelBroken; },
  };
}
