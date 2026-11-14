// Permission levels and approval binding for Agent Core (Batch 2).
// Security defaults: deny missing metadata, deny by default, fail closed.

import { createHash } from 'node:crypto';

// Five-level permission model. Levels are ordered 0..4; a grant only ever satisfies
// requirements at or below it. There is no implicit or default grant: host code must
// pass `grantedLevel` explicitly or every tool call is denied.
export const PERMISSION_LEVEL = Object.freeze({
  observe: 'observe',               // 0 - read-only, no side effects
  assist: 'assist',                 // 1 - reversible, low-impact local actions
  trusted: 'trusted',               // 2 - user-visible writes with limited scope
  sensitive: 'sensitive',           // 3 - sensitive or broad-scope actions, needs approval
  administrative: 'administrative', // 4 - system-level / destructive (not used in this batch)
});

export const PERMISSION_LEVEL_ORDER = Object.freeze({
  [PERMISSION_LEVEL.observe]: 0,
  [PERMISSION_LEVEL.assist]: 1,
  [PERMISSION_LEVEL.trusted]: 2,
  [PERMISSION_LEVEL.sensitive]: 3,
  [PERMISSION_LEVEL.administrative]: 4,
});

/** Accepts only the five canonical level names. Anything else (e.g. legacy "high") is invalid. */
export function normalizePermissionLevel(level) {
  const v = String(level ?? '').toLowerCase().trim();
  return Object.hasOwn(PERMISSION_LEVEL_ORDER, v) ? v : null;
}

export function permissionLevelRank(level) {
  const v = normalizePermissionLevel(level);
  return v == null ? null : PERMISSION_LEVEL_ORDER[v];
}

export function hasRequiredPermission(granted, required) {
  const g = normalizePermissionLevel(granted);
  const r = normalizePermissionLevel(required);
  if (!g || !r) return false;
  return PERMISSION_LEVEL_ORDER[g] >= PERMISSION_LEVEL_ORDER[r];
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function fingerprintAction(toolName, args = {}, context = {}) {
  const payload = stableStringify({ tool: String(toolName ?? ''), args: args ?? null, ctx: context ?? null });
  return createHash('sha256').update(payload).digest('hex');
}

export function defaultToolPermission(tool = {}) {
  const meta = tool.permission || tool.meta?.permission || tool.agentcore?.permission || null;
  if (!meta || typeof meta !== 'object') return null;
  const level = normalizePermissionLevel(meta.level);
  if (!level) return null;
  return {
    level,
    requiresApproval: meta.requiresApproval === true,
    approvalScopes: Array.isArray(meta.approvalScopes) ? meta.approvalScopes.filter((s) => typeof s === 'string') : null,
    description: typeof meta.description === 'string' ? meta.description : '',
    // Optional per-tool arg validator hook name/flag metadata only; execution uses provided functions.
  };
}

let approvalSeq = 1;

export function createApprovalStore({ now = () => Date.now(), defaultTtlMs = 60_000 } = {}) {
  const requests = new Map();
  const revoked = new Set(); // fingerprints or request ids revoked before execution

  function createRequest({ toolName, args = {}, normalizedArgs = null, permissionLevel, stepId = null, planId = null, reason = '', context = {}, ttlMs = defaultTtlMs }) {
    const effectiveArgs = normalizedArgs && typeof normalizedArgs === 'object' ? normalizedArgs : (args ?? {});
    const fingerprint = fingerprintAction(toolName, effectiveArgs, context?.approvalContext ?? null);
    const id = `apr_${now()}_${approvalSeq++}`;
    const req = {
      id,
      toolName: String(toolName ?? ''),
      args: effectiveArgs,
      fingerprint,
      permissionLevel: normalizePermissionLevel(permissionLevel) || null,
      stepId: stepId ? String(stepId) : null,
      planId: planId ? String(planId) : null,
      reason: String(reason ?? ''),
      createdAt: now(),
      expiresAt: now() + Math.max(1, Number(ttlMs) || defaultTtlMs),
      status: 'pending', // pending|approved|denied|expired|revoked|consumed|failed
      used: false,
      response: null,
      error: null,
    };
    requests.set(id, req);
    return req;
  }

  function get(id) { return id ? requests.get(String(id)) || null : null; }

  function markDenied(id, reason = 'denied') {
    const req = get(id); if (!req) return null;
    if (req.status === 'consumed' || req.status === 'revoked' || req.status === 'expired') return req;
    req.status = 'denied';
    req.response = { approved: false, reason: String(reason ?? 'denied') };
    return req;
  }

  function markApproved(id, binding = {}) {
    const req = get(id); if (!req) return { ok: false, reason: 'approval request not found', req: null };
    if (req.used || req.status === 'consumed') return { ok: false, reason: 'approval already used', req };
    if (req.status === 'revoked' || revoked.has(req.id) || revoked.has(req.fingerprint)) return { ok: false, reason: 'approval revoked', req };
    if (req.status === 'denied') return { ok: false, reason: 'approval denied', req };
    if (now() > req.expiresAt) { req.status = 'expired'; return { ok: false, reason: 'approval expired', req }; }
    // Bind response to the exact pending request identity.
    if (binding.requestId && String(binding.requestId) !== req.id) return { ok: false, reason: 'approval response request mismatch', req };
    if (binding.fingerprint && String(binding.fingerprint) !== req.fingerprint) return { ok: false, reason: 'approval response fingerprint mismatch', req };
    if (binding.toolName && String(binding.toolName) !== req.toolName) return { ok: false, reason: 'approval response tool mismatch', req };
    req.status = 'approved';
    req.response = { approved: true, at: now() };
    return { ok: true, req };
  }

  function consumeForExecution(id, { toolName, args = {}, context = {} } = {}) {
    const req = get(id); if (!req) return { ok: false, reason: 'approval request not found', req: null };
    if (req.used || req.status === 'consumed') return { ok: false, reason: 'approval already used', req };
    if (revoked.has(req.id) || revoked.has(req.fingerprint) || req.status === 'revoked') { req.status = 'revoked'; return { ok: false, reason: 'approval revoked', req }; }
    if (now() > req.expiresAt) { req.status = 'expired'; return { ok: false, reason: 'approval expired', req }; }
    if (req.status !== 'approved') return { ok: false, reason: `approval not granted (${req.status})`, req };
    if (String(toolName ?? '') !== req.toolName) return { ok: false, reason: 'approval tool mismatch', req };
    const fp = fingerprintAction(toolName, args, context?.approvalContext ?? null);
    if (fp !== req.fingerprint) return { ok: false, reason: 'approval arguments/context mismatch', req };
    req.used = true;
    req.status = 'consumed';
    return { ok: true, req };
  }

  function revoke(target) {
    const key = String(target ?? '');
    if (!key) return false;
    revoked.add(key);
    for (const req of requests.values()) {
      if (req.id === key || req.fingerprint === key) {
        if (!req.used && req.status !== 'consumed') req.status = 'revoked';
      }
    }
    return true;
  }

  function isRevoked(reqOrId) {
    const req = typeof reqOrId === 'string' ? get(reqOrId) : reqOrId;
    if (!req) return revoked.has(String(reqOrId ?? ''));
    return revoked.has(req.id) || revoked.has(req.fingerprint) || req.status === 'revoked';
  }

  return { createRequest, get, markApproved, markDenied, consumeForExecution, revoke, isRevoked, requests };
}

/**
 * Normalize an approval response from an adapter/UI. Fail closed on ambiguity.
 * Accepted shapes: boolean, {approved:boolean,...}, {decision:'approved'|'denied'|...}
 */
export function interpretApprovalResponse(response, request) {
  if (response === true) return { approved: true, requestId: request?.id ?? null, fingerprint: request?.fingerprint ?? null };
  if (response === false || response == null) return { approved: false, reason: response == null ? 'no approval response' : 'denied' };
  if (typeof response === 'object') {
    if (response.timeout === true) return { approved: false, reason: 'approval timed out', timeout: true, requestId: response.requestId ?? request?.id ?? null };
    if (response.revoked === true) return { approved: false, reason: 'approval revoked', revoked: true, requestId: response.requestId ?? request?.id ?? null };
    if (response.expired === true) return { approved: false, reason: 'approval expired', requestId: response.requestId ?? request?.id ?? null };
    const approved = response.approved === true || response.decision === 'approved' || response.allow === true;
    const denied = response.approved === false || response.decision === 'denied' || response.allow === false || response.cancelled === true || response.canceled === true;
    if (approved && !denied) {
      return { approved: true, requestId: response.requestId ?? request?.id ?? null, fingerprint: response.fingerprint ?? request?.fingerprint ?? null, toolName: response.toolName ?? request?.toolName ?? null };
    }
    if (denied) return { approved: false, reason: String(response.reason ?? 'denied'), requestId: response.requestId ?? request?.id ?? null };
  }
  return { approved: false, reason: 'unrecognized approval response' };
}
