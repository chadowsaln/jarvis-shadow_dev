// Execution engine for the agent core (Batch 2).
// Enforces approval binding, rechecks permissions/safety immediately before execution,
// fails closed, and never executes after denial/revocation/timeout/cancel.

import { isPlanTerminal, updateStep, STEP_STATUS, PLAN_STATUS, refreshPlan } from './planner.mjs';
import { createApprovalStore, interpretApprovalResponse, fingerprintAction } from './permissions.mjs';

function now() { return Date.now(); }

export function createExecutor({
  runTool, // async ({ step, plan, tool, args, signal, intent, route }) => result
  requestApproval, // async ({ request, step, plan, tool, args, route }) => response
  logger = null,
  approvals = null,
  safety = null, // optional { preflight } hook owned by the executor (adapter-independent recheck)

  approvalTtlMs = null, // when null, the approval store's own default TTL applies
  now: nowFn = now,
} = {}) {
  const logs = [];
  let cancelled = false;
  let pauseRequested = false;
  let currentAbort = null;
  let revoked = false;
  const inFlight = new Set(); // guard against concurrent duplicate execution of one step
  const store = approvals || createApprovalStore({ now: nowFn, ...(approvalTtlMs != null ? { defaultTtlMs: approvalTtlMs } : {}) });

  const log = (entry) => {
    const e = { at: nowFn(), ...entry };
    logs.push(e);
    try { logger?.(e); } catch {}
    return e;
  };

  // Executor-owned safety gate. Runs independently of the router so an adapter that
  // forgets to forward ctx.phase cannot skip the pre-execution recheck. Fail closed.
  function safetyGate(phase, ctx, toolName, args, route) {
    const hook = ctx?.safety ?? safety ?? null;
    if (!hook || typeof hook.preflight !== 'function') return null;
    try {
      const r = hook.preflight({
        toolName,
        args,
        permissionMeta: route?.permissionMeta ?? null,
        phase,
        grantedLevel: route?.grantedLevel ?? null,
        requestedLevel: route?.requiredLevel ?? null,
        route: route ?? null,
      });
      if (r && r.ok === false) return String(r.reason || `safety denied at ${phase}`);
      return null;
    } catch (e) {
      return `safety preflight error: ${String(e?.message || e)}`;
    }
  }

  function revoke(reason = 'permission revoked') {
    revoked = true;
    log({ type: 'permissions_revoked', reason });
  }

  async function executeStep(plan, step, ctx = {}) {
    // Race guard: a single step must never be authorized/executed twice concurrently
    // (two approval requests could otherwise both be approved and both run).
    const key = `${plan?.id ?? '?'}:${step?.id ?? '?'}`;
    if (inFlight.has(key)) {
      const reason = 'step already executing';
      log({ type: 'step_denied', planId: plan?.id ?? null, stepId: step?.id ?? null, reason });
      return { status: 'denied', reason };
    }
    inFlight.add(key);
    try {
      return await executeStepInner(plan, step, ctx);
    } finally {
      inFlight.delete(key);
    }
  }

  async function executeStepInner(plan, step, ctx = {}) {
    if (cancelled) return { status: 'cancelled', reason: 'cancelled' };
    if (revoked) {
      updateStep(plan, step.id, { status: STEP_STATUS.failed, error: 'permission revoked before execution', attempts: (step.attempts || 0) + 1 });
      log({ type: 'step_denied', planId: plan.id, stepId: step.id, reason: 'permission revoked before execution' });
      return { status: 'denied', reason: 'permission revoked' };
    }

    const toolName = step.tool;
    const args = step.args || {};
    const route = (name, a, extra = {}) => (ctx.router?.route?.(name, a, { ...ctx, ...extra }) ?? ctx.route?.(name, a, { ...ctx, ...extra }));

    const initialSafetyDenied = safetyGate('initial', ctx, toolName, args, null);
    if (initialSafetyDenied) {
      updateStep(plan, step.id, { status: STEP_STATUS.failed, error: initialSafetyDenied, attempts: (step.attempts || 0) + 1 });
      log({ type: 'step_denied', planId: plan.id, stepId: step.id, tool: toolName, reason: initialSafetyDenied, phase: 'initial' });
      return { status: 'denied', reason: initialSafetyDenied };
    }

    const routed = route(toolName, args, { phase: 'initial' });
    if (!routed || routed.allowed !== true) {
      const reason = routed?.reason || 'tool call denied';
      updateStep(plan, step.id, { status: STEP_STATUS.failed, error: reason, attempts: (step.attempts || 0) + 1 });
      log({ type: 'step_denied', planId: plan.id, stepId: step.id, tool: toolName, reason });
      return { status: 'denied', reason };
    }

    let approvalRequest = null;
    const execArgs = routed.normalizedArgs ?? args;
    const approvalContextValue = ctx.approvalContext ?? routed.fingerprintContext?.approvalContext ?? null;

    if (routed.requiresApproval) {
      approvalRequest = store.createRequest({
        toolName,
        args,
        normalizedArgs: execArgs,
        permissionLevel: routed.permissionMeta?.level || routed.requiredLevel || null,
        stepId: step.id,
        planId: plan.id,
        reason: routed.reason || 'approval required',
        context: { approvalContext: approvalContextValue },
        ttlMs: ctx.approvalTtlMs ?? approvalTtlMs ?? store.defaultTtlMs ?? undefined,
      });
      updateStep(plan, step.id, { status: STEP_STATUS.waiting_approval, meta: { ...(step.meta || {}), approvalRequestId: approvalRequest.id } });
      plan.status = PLAN_STATUS.paused;
      log({ type: 'approval_requested', planId: plan.id, stepId: step.id, tool: toolName, approvalRequestId: approvalRequest.id, fingerprint: approvalRequest.fingerprint });

      let approved = false;
      let response;
      try {
        response = typeof requestApproval === 'function'
          ? await requestApproval({ request: approvalRequest, step, plan, tool: routed.tool, args: execArgs, route: routed })
          : { approved: false, reason: 'no approval handler' };
      } catch (e) {
        const msg = `approval error: ${String(e?.message || e)}`;
        store.markDenied(approvalRequest.id, msg);
        updateStep(plan, step.id, { status: STEP_STATUS.failed, error: msg, meta: { ...(step.meta || {}), approvalRequestId: approvalRequest.id } });
        log({ type: 'approval_error', planId: plan.id, stepId: step.id, approvalRequestId: approvalRequest.id, error: String(e?.message || e) });
        return { status: 'failed', reason: msg };
      }

      const interpreted = interpretApprovalResponse(response, approvalRequest);
      if (interpreted.timeout) { store.get(approvalRequest.id).status = 'expired'; }
      if (interpreted.revoked) { store.revoke(approvalRequest.id); }

      if (!interpreted.approved) {
        store.markDenied(approvalRequest.id, interpreted.reason || 'denied');
        const reason = interpreted.reason || 'approval denied';
        updateStep(plan, step.id, { status: STEP_STATUS.failed, error: reason, meta: { ...(step.meta || {}), approvalRequestId: approvalRequest.id } });
        log({ type: 'approval_denied', planId: plan.id, stepId: step.id, approvalRequestId: approvalRequest.id, reason });
        return { status: 'denied', reason };
      }

      const bind = store.markApproved(approvalRequest.id, {
        requestId: interpreted.requestId ?? approvalRequest.id,
        fingerprint: interpreted.fingerprint ?? approvalRequest.fingerprint,
        toolName: interpreted.toolName ?? approvalRequest.toolName,
      });
      if (!bind.ok) {
        updateStep(plan, step.id, { status: STEP_STATUS.failed, error: bind.reason, meta: { ...(step.meta || {}), approvalRequestId: approvalRequest.id } });
        log({ type: 'approval_denied', planId: plan.id, stepId: step.id, approvalRequestId: approvalRequest.id, reason: bind.reason });
        return { status: 'denied', reason: bind.reason };
      }
      if (cancelled) {
        updateStep(plan, step.id, { status: STEP_STATUS.cancelled, error: 'cancelled after approval', meta: { ...(step.meta || {}), approvalRequestId: approvalRequest.id } });
        return { status: 'cancelled', reason: 'cancelled after approval' };
      }
      log({ type: 'approval_granted', planId: plan.id, stepId: step.id, approvalRequestId: approvalRequest.id });
    }

    // Recheck permission/safety immediately before execution (authoritative boundary).
    const preExecSafetyDenied = safetyGate('pre_execute', ctx, toolName, execArgs, null);
    const preExec = route(toolName, execArgs, { phase: 'pre_execute', approvalRequestId: approvalRequest?.id ?? null });
    if (preExecSafetyDenied) {
      if (approvalRequest) store.markDenied(approvalRequest.id, preExecSafetyDenied);
      updateStep(plan, step.id, { status: STEP_STATUS.failed, error: preExecSafetyDenied, meta: { ...(step.meta || {}), approvalRequestId: approvalRequest?.id || null } });
      log({ type: 'step_denied', planId: plan.id, stepId: step.id, tool: toolName, reason: preExecSafetyDenied, phase: 'pre_execute' });
      return { status: 'denied', reason: preExecSafetyDenied };
    }
    if (!preExec || preExec.allowed !== true) {
      const reason = preExec?.reason || 'recheck denied before execution';
      if (approvalRequest) store.markDenied(approvalRequest.id, reason);
      updateStep(plan, step.id, { status: STEP_STATUS.failed, error: reason, meta: { ...(step.meta || {}), approvalRequestId: approvalRequest?.id || null } });
      log({ type: 'step_denied', planId: plan.id, stepId: step.id, tool: toolName, reason, phase: 'pre_execute' });
      return { status: 'denied', reason };
    }
    if (revoked || cancelled || store.isRevoked(approvalRequest?.id || approvalRequest?.fingerprint || '')) {
      const reason = cancelled ? 'cancelled before execution' : 'permission revoked before execution';
      if (approvalRequest) store.revoke(approvalRequest.id);
      updateStep(plan, step.id, { status: cancelled ? STEP_STATUS.cancelled : STEP_STATUS.failed, error: reason, meta: { ...(step.meta || {}), approvalRequestId: approvalRequest?.id || null } });
      log({ type: cancelled ? 'step_cancelled' : 'step_denied', planId: plan.id, stepId: step.id, reason, phase: 'pre_execute' });
      return { status: cancelled ? 'cancelled' : 'denied', reason };
    }
    // A policy that starts requiring approval only at recheck time must not be bypassed.
    if (preExec.requiresApproval === true && !approvalRequest) {
      const reason = 'approval required (recheck) but no approved request is bound';
      updateStep(plan, step.id, { status: STEP_STATUS.failed, error: reason });
      log({ type: 'step_denied', planId: plan.id, stepId: step.id, tool: toolName, reason, phase: 'pre_execute' });
      return { status: 'denied', reason };
    }
    const finalArgs = preExec.normalizedArgs ?? execArgs;
    if (approvalRequest) {
      // Approval must be bound to the exact action actually about to execute.
      // createRequest/consume fingerprint using (toolName,args, approvalContextValue).
      const preFingerprint = fingerprintAction(toolName, finalArgs, approvalContextValue);
      if (preFingerprint !== approvalRequest.fingerprint || toolName !== approvalRequest.toolName) {
        const reason = 'approval binding mismatch before execution';
        store.markDenied(approvalRequest.id, reason);
        updateStep(plan, step.id, { status: STEP_STATUS.failed, error: reason, meta: { ...(step.meta || {}), approvalRequestId: approvalRequest.id } });
        log({ type: 'approval_denied', planId: plan.id, stepId: step.id, approvalRequestId: approvalRequest.id, reason, phase: 'pre_execute' });
        return { status: 'denied', reason };
      }
      const consume = store.consumeForExecution(approvalRequest.id, {
        toolName,
        args: finalArgs,
        context: { approvalContext: approvalContextValue },
      });
      if (!consume.ok) {
        updateStep(plan, step.id, { status: STEP_STATUS.failed, error: consume.reason, meta: { ...(step.meta || {}), approvalRequestId: approvalRequest.id } });
        log({ type: 'approval_denied', planId: plan.id, stepId: step.id, approvalRequestId: approvalRequest.id, reason: consume.reason, phase: 'pre_execute' });
        return { status: 'denied', reason };
      }
    }

    updateStep(plan, step.id, { status: STEP_STATUS.running, attempts: (step.attempts || 0) + 1, meta: { ...(step.meta || {}), approvalRequestId: approvalRequest?.id || null } });
    plan.status = PLAN_STATUS.running;
    log({ type: 'step_started', planId: plan.id, stepId: step.id, tool: toolName, approvalRequestId: approvalRequest?.id || null });

    if (typeof runTool !== 'function') {
      const reason = 'no runTool handler configured';
      updateStep(plan, step.id, { status: STEP_STATUS.failed, error: reason });
      log({ type: 'step_failed', planId: plan.id, stepId: step.id, error: reason });
      return { status: 'failed', reason };
    }

    const ac = new AbortController();
    currentAbort = ac;
    try {
      const result = await runTool({ step, plan, tool: preExec.tool || routed.tool, args: finalArgs, signal: ac.signal, intent: ctx.intent, route: preExec, approvalRequest });
      if (cancelled || ac.signal.aborted) {
        updateStep(plan, step.id, { status: STEP_STATUS.cancelled, error: 'cancelled' });
        log({ type: 'step_cancelled', planId: plan.id, stepId: step.id });
        return { status: 'cancelled', reason: 'cancelled' };
      }
      updateStep(plan, step.id, { status: STEP_STATUS.completed, result: result ?? null, error: null });
      log({ type: 'step_completed', planId: plan.id, stepId: step.id });
      return { status: 'completed', result };
    } catch (e) {
      const msg = String(e?.message || e);
      const st = cancelled || ac.signal.aborted ? STEP_STATUS.cancelled : STEP_STATUS.failed;
      updateStep(plan, step.id, { status: st, error: msg });
      log({ type: st === STEP_STATUS.cancelled ? 'step_cancelled' : 'step_failed', planId: plan.id, stepId: step.id, error: msg });
      return { status: st === STEP_STATUS.cancelled ? 'cancelled' : 'failed', reason: msg };
    } finally {
      if (currentAbort === ac) currentAbort = null;
    }
  }

  async function runReadySteps(plan, ctx = {}, { maxSteps = 1 } = {}) {
    if (isPlanTerminal(plan)) return { ran: 0, plan };
    if (pauseRequested) { plan.status = PLAN_STATUS.paused; return { ran: 0, paused: true, plan }; }
    let ran = 0;
    while (ran < maxSteps && !cancelled && !pauseRequested) {
      refreshPlan(plan);
      const ready = plan.steps.find((s) => s.status === STEP_STATUS.ready);
      if (!ready) break;
      const r = await executeStep(plan, ready, ctx);
      ran++;
      if (r.status === 'failed' || r.status === 'denied' || r.status === 'cancelled') break;
    }
    refreshPlan(plan);
    return { ran, plan, cancelled };
  }

  return {
    log,
    getLogs() { return logs.slice(); },
    isCancelled() { return cancelled; },
    isRevoked() { return revoked; },
    approvals: store,
    pause() { pauseRequested = true; log({ type: 'pause_requested' }); },
    resume() { pauseRequested = false; log({ type: 'resume_requested' }); },
    cancel(reason = 'cancelled') {
      cancelled = true;
      pauseRequested = false;
      log({ type: 'cancel_requested', reason });
      try { currentAbort?.abort(reason); } catch {}
    },
    /**
     * Start a new run: clears cancel/pause/revoke so the next request can act again. Approvals already revoked or
     * consumed in the store stay dead - this reopens the executor, never an approval.
     */
    reset(reason = 'new run') {
      cancelled = false;
      pauseRequested = false;
      revoked = false;
      log({ type: 'executor_reset', reason });
    },
    revoke,
    async executeStep(plan, step, ctx) { return executeStep(plan, step, ctx); },
    async runReadySteps(plan, ctx, opts) { return runReadySteps(plan, ctx, opts); },
  };
}
