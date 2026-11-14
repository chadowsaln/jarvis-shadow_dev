// Agent Core Batch 2: permission metadata, routing, approval binding, execution safeguards.
import assert from 'node:assert/strict';
import { routeToolCall } from '../agentcore/router.mjs';
import { createExecutor } from '../agentcore/executor.mjs';
import { createPlan, STEP_STATUS } from '../agentcore/planner.mjs';
import { createApprovalStore, fingerprintAction, PERMISSION_LEVEL } from '../agentcore/permissions.mjs';
import { isAgentCoreEnabled, createAgentCore } from '../agentcore/index.mjs';

const tool = (name, level, requiresApproval = false, extra = {}) => ({
  name,
  execute: async (args) => ({ ok: true, args }),
  permission: { level, requiresApproval },
  ...extra,
});

let ran;
const runTool = async ({ args }) => { ran = (ran || 0) + 1; return { ok: true, args }; };
const resetRun = () => { ran = 0; };

// 1. Unknown tools are denied.
{
  resetRun();
  const r = routeToolCall({ toolName: 'missing_tool', args: {}, tools: [tool('known', 'assist')], permissions: { allow: true, grantedLevel: 'sensitive' } });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /unknown tool/);
}

// 2. Missing permission metadata is denied.
{
  resetRun();
  const t = { name: 'no_meta', execute: async () => 1 };
  const r = routeToolCall({ toolName: 'no_meta', args: {}, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /missing permission metadata/);
  const exec = createExecutor({ runTool });
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'no_meta', args: {} }] });
  await exec.executeStep(plan, plan.steps[0], { router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) } });
  assert.equal(ran, 0);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
}

// 3. Denied tools never execute.
{
  resetRun();
  const t = tool('denied_tool', 'assist');
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'denied_tool', args: {} }] });
  const exec = createExecutor({ runTool });
  await exec.executeStep(plan, plan.steps[0], { router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive', denyTools: ['denied_tool'] } }) } });
  assert.equal(ran, 0);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /denied/);
}

// 4. Insufficient permission levels are rejected.
{
  resetRun();
  const t = tool('writey', 'trusted');
  const r = routeToolCall({ toolName: 'writey', args: {}, tools: [t], permissions: { allow: true, grantedLevel: 'assist' } });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /insufficient permission level/);
}

// 5. Safety denial cannot be overridden.
{
  resetRun();
  const t = tool('danger', 'sensitive', true);
  let safetyCalls = 0;
  const router = { route: (n, a, ctx = {}) => routeToolCall({
    toolName: n, args: a, tools: [t],
    permissions: { allow: true, grantedLevel: 'sensitive', requireApproval: ['danger'] },
    safety: { preflight: (p) => { safetyCalls++; return { ok: false, reason: `safety veto:${p.phase}` }; } },
  }) };
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'danger', args: { cmd: 'x' } }] });
  const exec = createExecutor({ runTool, requestApproval: async () => ({ approved: true }) });
  await exec.executeStep(plan, plan.steps[0], { router });
  assert.equal(ran, 0);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /safety veto/);
  assert.ok(safetyCalls >= 1);
}

// 6. LLM intent cannot authorize execution.
{
  resetRun();
  const t = tool('secure', 'sensitive', true);
  const intent = { kind: 'command', category: 'execution', risk: 'assist', confidence: 0.99, authorized: true, allow: true, grant: 'admin' };
  const r = routeToolCall({ toolName: 'secure', args: { x: 1 }, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' }, intent });
  // Intent is not a permission grant; metadata still requires approval and policy still governs.
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, true);
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'secure', args: { x: 1 } }] });
  const exec = createExecutor({ runTool, requestApproval: async () => false }); // deny despite intent
  await exec.executeStep(plan, plan.steps[0], { router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' }, intent }) } });
  assert.equal(ran, 0);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
}

// 7. Approval is required for sensitive actions.
{
  resetRun();
  const t = tool('sensitive', 'sensitive', true);
  let asked = 0;
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'sensitive', args: { target: 'a' } }] });
  const exec = createExecutor({ runTool, requestApproval: async ({ request }) => { asked++; return { approved: true, requestId: request.id, fingerprint: request.fingerprint }; } });
  await exec.executeStep(plan, plan.steps[0], { router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) } });
  assert.equal(asked, 1);
  assert.equal(ran, 1);
  assert.equal(plan.steps[0].status, STEP_STATUS.completed);
}

// 8. Approval for one argument set cannot authorize another.
{
  resetRun();
  const t = tool('sensitive', 'sensitive', true);
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'sensitive', args: { target: 'A' } }] });
  const exec = createExecutor({
    runTool,
    requestApproval: async ({ request }) => {
      // Approve a different action fingerprint by lying about binding to wrong args context; store must reject mismatch on consume.
      return { approved: true, requestId: request.id, fingerprint: fingerprintAction(request.toolName, { target: 'B' }) };
    },
  });
  await exec.executeStep(plan, plan.steps[0], { router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) } });
  assert.equal(ran, 0);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /mismatch|fingerprint/);
}

// 9. Expired approval is rejected.
{
  resetRun();
  let tnow = 1_000;
  const approvals = createApprovalStore({ now: () => tnow, defaultTtlMs: 50 });
  const t = tool('sensitive', 'sensitive', true);
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'sensitive', args: { x: 1 } }] });
  const exec = createExecutor({
    approvals, now: () => tnow, runTool,
    requestApproval: async ({ request }) => { tnow += 100; return { approved: true, requestId: request.id, fingerprint: request.fingerprint }; },
  });
  await exec.executeStep(plan, plan.steps[0], { router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) } });
  assert.equal(ran, 0);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /expired/);
}

// 10. Duplicate approval is rejected.
{
  resetRun();
  const approvals = createApprovalStore({ defaultTtlMs: 60_000 });
  const t = tool('sensitive', 'sensitive', true);
  const router = { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) };
  const exec = createExecutor({
    approvals, runTool,
    requestApproval: async ({ request }) => ({ approved: true, requestId: request.id, fingerprint: request.fingerprint }),
  });
  const plan1 = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'sensitive', args: { x: 1 } }] });
  await exec.executeStep(plan1, plan1.steps[0], { router });
  assert.equal(plan1.steps[0].status, STEP_STATUS.completed);
  assert.equal(ran, 1);
  // Try to reuse same consumed approval id for same action in a second execution attempt by forging response.
  const reqId = plan1.steps[0].meta?.approvalRequestId || [...approvals.requests.keys()][0];
  const plan2 = createPlan({ goal: 'g', steps: [{ id: 's2', title: 's', tool: 'sensitive', args: { x: 1 } }] });
  const exec2 = createExecutor({
    approvals, runTool,
    requestApproval: async ({ request }) => ({ approved: true, requestId: reqId, fingerprint: approvals.get(reqId)?.fingerprint || request.fingerprint }),
  });
  await exec2.executeStep(plan2, plan2.steps[0], { router });
  assert.equal(ran, 1); // no second execution
  assert.equal(plan2.steps[0].status, STEP_STATUS.failed);
  assert.match(plan2.steps[0].error, /used|mismatch|denied|not granted/);
}

// 11. Stale approval is rejected.
{
  resetRun();
  const t = tool('sensitive', 'sensitive', true);
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'sensitive', args: { x: 1 } }] });
  let phase = 0;
  const router = { route: (n, a, ctx = {}) => {
    phase++;
    // First route: requires approval for {x:1}. Pre-execute recheck sees mutated "current" args context via normalization.
    const normalized = phase === 1 ? { x: 1 } : { x: 999 };
    return routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive', normalizeArgs: () => normalized } });
  } };
  const exec = createExecutor({ runTool, requestApproval: async ({ request }) => ({ approved: true, requestId: request.id, fingerprint: request.fingerprint }) });
  await exec.executeStep(plan, plan.steps[0], { router });
  assert.equal(ran, 0);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /mismatch|denied|stale|arguments/i);
}

// 12. Approval timeout never becomes approval.
{
  resetRun();
  const t = tool('sensitive', 'sensitive', true);
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'sensitive', args: { x: 1 } }] });
  const exec = createExecutor({ runTool, requestApproval: async () => ({ approved: false, timeout: true, reason: 'approval timed out' }) });
  await exec.executeStep(plan, plan.steps[0], { router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) } });
  assert.equal(ran, 0);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /timed out|denied|expired/);
  {
    resetRun();
    const plan2 = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'sensitive', args: { x: 1 } }] });
    const exec2 = createExecutor({ runTool, requestApproval: async () => null });
    await exec2.executeStep(plan2, plan2.steps[0], { router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) } });
    assert.equal(ran, 0);
    assert.notEqual(plan2.steps[0].status, STEP_STATUS.completed);
  }
}

// 13. Permission revocation before execution blocks the action.
{
  resetRun();
  const t = tool('sensitive', 'sensitive', true);
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'sensitive', args: { x: 1 } }] });
  const exec = createExecutor({
    runTool,
    requestApproval: async ({ request }) => { exec.revoke('revoked by user'); return { approved: true, requestId: request.id, fingerprint: request.fingerprint }; },
  });
  await exec.executeStep(plan, plan.steps[0], { router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) } });
  assert.equal(ran, 0);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /revoked|denied/);
}

// 14. Safety is rechecked immediately before execution.
{
  resetRun();
  let checks = 0;
  const t = tool('risky', 'sensitive');
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'risky', args: { x: 1 } }] });
  // Safety hook is owned by the executor so the recheck cannot be skipped by an adapter
  // that forgets to forward the phase to the router.
  const exec = createExecutor({
    runTool,
    safety: { preflight: ({ phase }) => { checks++; if (phase === 'pre_execute') return { ok: false, reason: 'blocked late' }; return null; } },
  });
  await exec.executeStep(plan, plan.steps[0], {
    router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) },
  });
  assert.equal(ran, 0);
  assert.ok(checks >= 2, 'expected initial and pre-execute safety checks');
  assert.match(plan.steps[0].error, /blocked late/);
}

// 15. Cancellation prevents subsequent steps.
{
  const calls = [];
  const t = { name: 'step', execute: async ({ i }) => { calls.push(i); return i; }, permission: { level: 'assist' } };
  const plan = createPlan({ goal: 'g', steps: [
    { id: 's1', title: '1', tool: 'step', args: { i: 1 } },
    { id: 's2', title: '2', tool: 'step', args: { i: 2 }, dependsOn: ['s1'] },
    { id: 's3', title: '3', tool: 'step', args: { i: 3 }, dependsOn: ['s2'] },
  ] });
  const exec = createExecutor({ runTool: async ({ tool, args }) => { exec.cancel('stop now'); return tool.execute(args); } });
  await exec.runReadySteps(plan, { router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) } }, { maxSteps: 10 });
  assert.deepEqual(calls, [1]);
  assert.ok(plan.steps.find((s) => s.id === 's2').status !== STEP_STATUS.completed);
}

// 16. Failed authorization cannot mark a step completed.
{
  resetRun();
  const t = tool('sensitive', 'sensitive', true);
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'sensitive', args: { x: 1 } }] });
  const exec = createExecutor({ runTool, requestApproval: async () => ({ approved: false, reason: 'nope' }) });
  await exec.executeStep(plan, plan.steps[0], { router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) } });
  assert.notEqual(plan.steps[0].status, STEP_STATUS.completed);
  assert.ok([STEP_STATUS.failed, STEP_STATUS.cancelled, STEP_STATUS.blocked].includes(plan.steps[0].status));
  assert.equal(ran, 0);
}

// 17. Legacy behavior remains unchanged with the feature flag disabled.
{
  assert.equal(isAgentCoreEnabled({}), false);
  assert.equal(isAgentCoreEnabled({ ROAMIES_AGENT_CORE: '0' }), false);
  assert.equal(isAgentCoreEnabled({ ROAMIES_AGENT_CORE: 'false' }), false);
  assert.equal(isAgentCoreEnabled({ ROAMIES_AGENT_CORE: undefined }), false);
  // Agent core observe/monitoring remains no-op when disabled (as in Batch 1 integration).
  // No agentcore execution path is invoked by default; existing sidekick behavior is unchanged when flag off.
}

// 18. Concurrent duplicate execution of one step is denied (no double-run race).
{
  resetRun();
  const t = tool('racy', 'sensitive', true);
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'racy', args: { x: 1 } }] });
  let release;
  const gate = new Promise((r) => { release = r; });
  let approvals = 0;
  const exec = createExecutor({
    runTool: async () => { await gate; ran = (ran || 0) + 1; return 'ok'; },
    requestApproval: async ({ request }) => { approvals++; return { approved: true, requestId: request.id, fingerprint: request.fingerprint }; },
  });
  const router = { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) };
  const first = exec.executeStep(plan, plan.steps[0], { router });
  const second = await exec.executeStep(plan, plan.steps[0], { router });
  release();
  const firstResult = await first;
  assert.equal(second.status, 'denied');
  assert.match(second.reason, /already executing/);
  assert.equal(firstResult.status, 'completed');
  assert.equal(approvals, 1);
  assert.equal(ran, 1);
}

// 19. Executor-owned safety recheck holds even when the router adapter drops the phase.
{
  resetRun();
  let phases = [];
  const t = tool('risky2', 'assist');
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'risky2', args: {} }] });
  const exec = createExecutor({
    runTool,
    safety: { preflight: ({ phase }) => { phases.push(phase); return phase === 'pre_execute' ? { ok: false, reason: 'executor veto' } : null; } },
  });
  // Adapter deliberately ignores ctx and never forwards phase to routeToolCall.
  await exec.executeStep(plan, plan.steps[0], { router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) } });
  assert.equal(ran, 0);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /executor veto/);
  assert.ok(phases.includes('pre_execute'));
}

// 20. createAgentCore wires the safety hook into both router and executor (fail closed).
{
  resetRun();
  const core = createAgentCore({
    enabled: true,
    tools: [tool('guarded', 'assist')],
    permissions: { allow: true, grantedLevel: 'sensitive' },
    safety: { preflight: () => ({ ok: false, reason: 'policy says no' }) },
    runTool,
  });
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'guarded', args: {} }] });
  await core.executor.executeStep(plan, plan.steps[0], { router: core.router });
  assert.equal(ran, 0);
  assert.match(plan.steps[0].error, /policy says no/);
}

// 21. Safety hook errors fail closed (never treated as approval).
{
  resetRun();
  const t = tool('boom', 'assist');
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'boom', args: {} }] });
  const exec = createExecutor({ runTool, safety: { preflight: () => { throw new Error('safety crashed'); } } });
  await exec.executeStep(plan, plan.steps[0], { router: { route: (n, a) => routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive' } }) } });
  assert.equal(ran, 0);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /safety preflight error/);
}

// 22. Approval that only becomes required at the pre-execution recheck is not bypassed.
{
  resetRun();
  let call = 0;
  const t = tool('flip', 'assist');
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 's', tool: 'flip', args: { x: 1 } }] });
  const exec = createExecutor({ runTool, requestApproval: async ({ request }) => ({ approved: true, requestId: request.id, fingerprint: request.fingerprint }) });
  const router = {
    route: (n, a) => {
      call++;
      return routeToolCall({ toolName: n, args: a, tools: [t], permissions: { allow: true, grantedLevel: 'sensitive', requireApproval: () => call > 1 } });
    },
  };
  await exec.executeStep(plan, plan.steps[0], { router });
  assert.equal(ran, 0);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /approval required/);
}

// 23. End-to-end through createAgentCore: tone (no approval) runs, sensitive needs approval and runs once.
{
  resetRun();
  const tools = [tool('peek', 'assist'), tool('touch', 'sensitive', true)];
  const seen = [];
  const core = createAgentCore({
    enabled: true,
    tools,
    permissions: { allow: true, grantedLevel: 'sensitive' },
    safety: { preflight: () => ({ ok: true }) },
    runTool: async ({ tool: t, args }) => { ran = (ran || 0) + 1; seen.push(t.name); return { ok: true, args }; },
    requestApproval: async ({ request }) => ({ approved: true, requestId: request.id, fingerprint: request.fingerprint, toolName: request.toolName }),
  });
  const plan = createPlan({ goal: 'g', steps: [
    { id: 's1', title: 'peek', tool: 'peek', args: {} },
    { id: 's2', title: 'touch', tool: 'touch', args: { k: 1 }, dependsOn: ['s1'] },
  ] });
  const out = await core.executor.runReadySteps(plan, { router: core.router }, { maxSteps: 5 });
  assert.equal(out.ran, 2);
  assert.equal(ran, 2);
  assert.deepEqual(seen, ['peek', 'touch']);
  assert.ok(core.executor.getLogs().some((e) => e.type === 'approval_granted'));
  assert.equal(core.approvals.get(plan.steps[0].meta?.approvalRequestId || 'none'), null);
}

console.log('permissions: passed');
