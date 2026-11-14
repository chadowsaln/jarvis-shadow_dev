// Tool router for the agent core (Batch 2).
// Deny by default. Permission metadata required in strict mode. Never weakens safety.

import { defaultToolPermission, hasRequiredPermission, normalizePermissionLevel, PERMISSION_LEVEL } from './permissions.mjs';

function findTool(tools, name) {
  if (!Array.isArray(tools)) return null;
  return tools.find((t) => t && t.name === name) ?? null;
}

function basicArgCheck(tool, args) {
  const errors = [];
  if (args != null && (typeof args !== 'object' || Array.isArray(args))) {
    errors.push('args must be an object');
    return errors;
  }
  const schema = tool?.parameters;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  for (const key of required) {
    if (!(key in (args || {})) || (args || {})[key] == null) errors.push(`missing required arg: ${key}`);
  }
  if (schema?.shape && typeof schema.shape === 'object') {
    for (const [key, def] of Object.entries(schema.shape)) {
      const isOptional = typeof def?.isOptional === 'function' ? def.isOptional() : def?._def?.typeName === 'ZodOptional' || def?._def?.typeName === 'ZodDefault';
      if (!isOptional && !(key in (args || {}))) {
        if (!required.includes(key)) errors.push(`missing required arg: ${key}`);
      }
    }
  }
  return errors;
}

function resolvePermissionMeta(tool, permissions) {
  const explicit = defaultToolPermission(tool);
  if (explicit) return explicit;
  // Optional policy override map (declarative metadata source), still metadata - not LLM.
  const byTool = permissions?.toolPermissions;
  if (byTool && typeof byTool === 'object') {
    const m = byTool[tool?.name];
    if (m && typeof m === 'object') {
      const level = normalizePermissionLevel(m.level);
      if (level) return { level, requiresApproval: m.requiresApproval === true, approvalScopes: Array.isArray(m.approvalScopes) ? m.approvalScopes : null, description: typeof m.description === 'string' ? m.description : '' };
    }
  }
  return null;
}

/**
 * Route/authorize a tool call.
 * Security: deny by default, missing metadata denied in strict mode, safety can veto,
 * permission level must be sufficient, approval is bound to normalized args.
 */
export function routeToolCall(input = {}) {
  const toolName = String(input.toolName ?? '');
  const args = input.args ?? {};
  const tools = input.tools ?? [];
  const permissions = input.permissions ?? {};
  const intent = input.intent ?? null;
  const strict = permissions.strictPermissions !== false; // Batch 2 default for agentcore routing: strict
  const tool = findTool(tools, toolName);

  if (!toolName) return { allowed: false, reason: 'tool name is required', requiresApproval: false };
  if (!tool) return { allowed: false, reason: `unknown tool: ${toolName}`, requiresApproval: false };

  const denyTools = permissions.denyTools instanceof Set ? permissions.denyTools : new Set(permissions.denyTools || []);
  if (denyTools.has(toolName)) return { allowed: false, tool, reason: `tool denied by policy: ${toolName}`, requiresApproval: false };

  const permissionMeta = resolvePermissionMeta(tool, permissions);
  if (strict && !permissionMeta) {
    return { allowed: false, tool, reason: `missing permission metadata: ${toolName}`, requiresApproval: false };
  }

  // Deny by default: explicit allow required.
  let explicitlyAllowed = permissions.allow === true;
  if (typeof permissions.allowTools === 'function') {
    try { explicitlyAllowed = explicitlyAllowed || !!permissions.allowTools({ toolName, tool, args, intent, permissionMeta }); } catch { explicitlyAllowed = false; }
  } else if (permissions.allowTools) {
    const allowSet = permissions.allowTools instanceof Set ? permissions.allowTools : new Set(permissions.allowTools);
    explicitlyAllowed = explicitlyAllowed || allowSet.has(toolName);
  }
  // Convenience for legacy non-strict callers: explicit allow is still required by default.
  if (!explicitlyAllowed) {
    return { allowed: false, tool, permissionMeta, reason: `tool not allowed by policy: ${toolName}`, requiresApproval: false };
  }

  // Permission level check (never controlled by LLM intent). Fail closed: no configured
  // host level means no grant at all, and unknown level names are rejected.
  const rawGranted = permissions.grantedLevel ?? permissions.level ?? null;
  const grantedLevel = normalizePermissionLevel(rawGranted);
  if (!grantedLevel) {
    return {
      allowed: false,
      tool,
      permissionMeta,
      grantedLevel: null,
      requiredLevel: permissionMeta?.level ?? null,
      reason: rawGranted == null
        ? `missing host permission level for ${toolName}`
        : `invalid host permission level for ${toolName}: ${String(rawGranted)}`,
      requiresApproval: false,
    };
  }
  const requiredLevel = permissionMeta?.level ?? normalizePermissionLevel(permissions.defaultRequiredLevel) ?? null;
  if (requiredLevel && !hasRequiredPermission(grantedLevel, requiredLevel)) {
    return { allowed: false, tool, permissionMeta, grantedLevel, requiredLevel, reason: `insufficient permission level for ${toolName}: requires ${requiredLevel}, granted ${grantedLevel}`, requiresApproval: false };
  }

  // Safety preflight can veto (never weakened). Rechecked by caller with phase 'pre_execute'.
  if (typeof input.safety?.preflight === 'function') {
    try {
      const phase = input.phase || 'route';
      const r = input.safety.preflight({ toolName, tool, args, intent, permissionMeta, phase });
      if (r && r.ok === false) return { allowed: false, tool, permissionMeta, reason: r.reason || `safety preflight denied: ${toolName}`, requiresApproval: false };
    } catch (e) {
      return { allowed: false, tool, permissionMeta, reason: `safety preflight error: ${String(e?.message || e)}`, requiresApproval: false };
    }
  }

  const argErrors = basicArgCheck(tool, args);
  if (argErrors.length) return { allowed: false, tool, permissionMeta, reason: `invalid args: ${argErrors.join('; ')}`, requiresApproval: false };

  if (typeof permissions.validateArgs === 'function') {
    try {
      const v = permissions.validateArgs({ toolName, tool, args, intent, permissionMeta });
      const errs = Array.isArray(v) ? v : (typeof v === 'string' && v ? [v] : []);
      if (errs.length) return { allowed: false, tool, permissionMeta, reason: `invalid args: ${errs.join('; ')}`, requiresApproval: false };
    } catch (e) {
      return { allowed: false, tool, permissionMeta, reason: `arg validation error: ${String(e?.message || e)}`, requiresApproval: false };
    }
  }

  let normalizedArgs = args;
  if (typeof permissions.normalizeArgs === 'function') {
    try {
      const n = permissions.normalizeArgs({ toolName, tool, args, intent, permissionMeta });
      if (n && typeof n === 'object' && !Array.isArray(n)) normalizedArgs = n;
    } catch (e) {
      return { allowed: false, tool, permissionMeta, reason: `arg normalization error: ${String(e?.message || e)}`, requiresApproval: false };
    }
  }

  let requiresApproval = permissionMeta?.requiresApproval === true;
  if (typeof permissions.requireApproval === 'function') {
    try { requiresApproval = !!permissions.requireApproval({ toolName, tool, args: normalizedArgs, intent, permissionMeta }); } catch { requiresApproval = true; }
  } else if (permissions.requireApproval) {
    const set = permissions.requireApproval instanceof Set ? permissions.requireApproval : new Set(permissions.requireApproval);
    if (set.has(toolName)) requiresApproval = true;
  }

  const decision = {
    allowed: true,
    tool,
    normalizedArgs,
    requiresApproval,
    permissionMeta: permissionMeta || { level: requiredLevel || null, requiresApproval },
    grantedLevel,
    requiredLevel: requiredLevel || permissionMeta?.level || null,
    reason: null,
  };
  Object.defineProperty(decision, 'fingerprintContext', { value: { approvalContext: permissions.approvalContext ?? null }, enumerable: false });
  return decision;
}

export function createRouter({ tools = [], permissions = {}, safety = {} } = {}) {
  return {
    listTools() { return Array.isArray(tools) ? tools.map((t) => t?.name).filter(Boolean) : []; },
    route(toolName, args = {}, ctx = {}) {
      const mergedPerms = { ...permissions, ...(ctx.permissions || {}) };
      // Inherit current granted level from context unless explicitly overridden.
      if (ctx.grantedLevel && !mergedPerms.grantedLevel) mergedPerms.grantedLevel = ctx.grantedLevel;
      return routeToolCall({ toolName, args, tools, permissions: mergedPerms, safety: { ...safety, ...(ctx.safety || {}) }, intent: ctx.intent ?? null, phase: ctx.phase || 'route' });
    },
  };
}
