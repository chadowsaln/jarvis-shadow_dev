// Agent core public API. Feature-flagged, disabled by default.

import { createIntentClassifier, classifyIntent } from './intent.mjs';
import { createPlan, validatePlan, updateStep, getReadySteps, refreshPlan, cancelPlan, isPlanComplete, isPlanTerminal, PLAN_STATUS, STEP_STATUS } from './planner.mjs';
import { createRouter, routeToolCall } from './router.mjs';
import { createExecutor } from './executor.mjs';
import { prepareContext, budgetMessages, selectRelevantContext, estimateTokens, adaptHistoryForProvider } from './context.mjs';
import { PERMISSION_LEVEL, PERMISSION_LEVEL_ORDER, normalizePermissionLevel, permissionLevelRank, hasRequiredPermission, defaultToolPermission, fingerprintAction, createApprovalStore, interpretApprovalResponse } from './permissions.mjs';
import { createApprovalChannel, sanitizeArgs, riskOf } from './approval-channel.mjs';
import { guardTools, createAgentCoreRuntime } from './runtime.mjs';

export const AGENT_CORE_FLAG = 'ROAMIES_AGENT_CORE';

/**
 * Feature flag: ON by default (V2.1). Every tool call goes through the router and executor unless the host turns
 * the core off with an explicit falsy value ("0", "false", "no", "off"). An unset or empty value means on:
 * the safe path must be the one everybody is on, not an opt-in.
 */
export function isAgentCoreEnabled(env = process.env) {
  const v = String(env?.[AGENT_CORE_FLAG] ?? '').toLowerCase().trim();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function defaultSafetyPreflight({ safety = {} } = {}) {
  return (ctx) => {
    // Delegate to existing safety modules/functions if provided; fail closed on error.
    if (typeof safety.preflight === 'function') return safety.preflight(ctx);
    if (typeof safety.check === 'function') return safety.check(ctx);
    return null; // no additional veto
  };
}

/**
 * Factory for agent core components.
 * When enabled for Batch 2 secure execution paths, routing requires permission metadata
 * and executor binds approvals/rechecks before execution. Legacy flag-off behavior unchanged.
 */
export function createAgentCore(options = {}) {
  const enabled = options.enabled ?? isAgentCoreEnabled(options.env || process.env);
  const intent = createIntentClassifier({ llmClassify: options.llmClassify || null });
  const approvals = options.approvals || createApprovalStore({ defaultTtlMs: options.approvalTtlMs ?? 60_000 });
  const permissions = {
    allow: options.permissions?.allow,
    allowTools: options.permissions?.allowTools,
    denyTools: options.permissions?.denyTools,
    requireApproval: options.permissions?.requireApproval,
    validateArgs: options.permissions?.validateArgs,
    normalizeArgs: options.permissions?.normalizeArgs,
    toolPermissions: options.permissions?.toolPermissions,
    // No default grant: an unset host level denies every tool call (fail closed).
    grantedLevel: options.permissions?.grantedLevel ?? options.permissions?.level ?? null,
    strictPermissions: options.permissions?.strictPermissions, // router defaults strict; caller may override
    approvalContext: options.permissions?.approvalContext ?? null,
    defaultRequiredLevel: options.permissions?.defaultRequiredLevel ?? null,
  };
  const safety = {
    ...options.safety,
    preflight: defaultSafetyPreflight({ safety: options.safety || {} }),
  };
  const router = createRouter({ tools: options.tools || [], permissions, safety });
  const executor = createExecutor({
    runTool: options.runTool,
    requestApproval: options.requestApproval,
    logger: options.logger,
    approvals,
    approvalTtlMs: options.approvalTtlMs ?? 60_000,
    // Same fail-closed hook the router uses, so the pre-execution recheck cannot be
    // skipped by an adapter that forgets to forward ctx.phase.
    safety,
  });

  return {
    enabled,
    flag: AGENT_CORE_FLAG,
    grantedLevel: permissions.grantedLevel,
    intent,
    planner: { createPlan, validatePlan, updateStep, getReadySteps, refreshPlan, cancelPlan, isPlanComplete, isPlanTerminal, PLAN_STATUS, STEP_STATUS },
    router,
    executor,
    approvals,
    permissions: { ...permissions, PERMISSION_LEVEL },
    context: { prepareContext, budgetMessages, selectRelevantContext, estimateTokens, adaptHistoryForProvider },
    observe(input = {}) {
      if (!enabled) return { enabled: false };
      const classification = classifyIntent(String(input.text ?? ''), { context: input.context });
      return { enabled: true, intent: classification, plan: input.plan ? { id: input.plan.id, status: input.plan.status } : null };
    },
  };
}

export {
  classifyIntent, createIntentClassifier,
  createPlan, validatePlan, updateStep, getReadySteps, refreshPlan, cancelPlan, isPlanComplete, isPlanTerminal, PLAN_STATUS, STEP_STATUS,
  createRouter, routeToolCall,
  createExecutor,
  prepareContext, budgetMessages, selectRelevantContext, estimateTokens, adaptHistoryForProvider,
  PERMISSION_LEVEL, PERMISSION_LEVEL_ORDER, normalizePermissionLevel, permissionLevelRank, hasRequiredPermission, defaultToolPermission, fingerprintAction, createApprovalStore, interpretApprovalResponse,
  createApprovalChannel, sanitizeArgs, riskOf,
  guardTools, createAgentCoreRuntime,
};

