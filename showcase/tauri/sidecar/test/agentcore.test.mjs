// Agent core Batch 1+2: intent, planning, routing, execution, permissions/approval security, context.
import assert from 'node:assert/strict';
import { createIntentClassifier, classifyIntent } from '../agentcore/intent.mjs';
import { createPlan, validatePlan, updateStep, getReadySteps, refreshPlan, cancelPlan, isPlanComplete, isPlanTerminal, PLAN_STATUS, STEP_STATUS } from '../agentcore/planner.mjs';
import { routeToolCall, createRouter } from '../agentcore/router.mjs';
import { createExecutor } from '../agentcore/executor.mjs';
import { budgetMessages, selectRelevantContext, prepareContext, estimateTokens, adaptHistoryForProvider } from '../agentcore/context.mjs';
import { createAgentCore, isAgentCoreEnabled, AGENT_CORE_FLAG, PERMISSION_LEVEL } from '../agentcore/index.mjs';
import { approxTokens, fitContext, forProvider } from '../store.mjs';

const meta = (level = 'assist', requiresApproval = false) => ({ permission: { level, requiresApproval } });

// ---- Intent classification ----
{
  const q = classifyIntent('What is the weather today?');
  assert.equal(q.kind, 'question');
  assert.ok(q.confidence > 0);
  const cmd = classifyIntent('open the Downloads folder');
  assert.ok(cmd.kind === 'command' || cmd.kind === 'task');
  const task = classifyIntent('create a plan and then refactor the module step by step');
  assert.equal(task.kind, 'task');
  assert.equal(classifyIntent('hello there').kind, 'chat');
  const risky = classifyIntent('delete all files and run rm -rf /tmp/x');
  assert.equal(risky.risk, 'high');
}
{
  const classifier = createIntentClassifier({ llmClassify: async () => ({ kind: 'task', category: 'custom', confidence: 0.9, signals: ['llm'] }) });
  const out = await classifier.classify('hi');
  assert.equal(out.kind, 'task');
  assert.equal(out.category, 'custom');
  assert.ok(out.signals.includes('llm'));
  const fallback = createIntentClassifier({ llmClassify: async () => { throw new Error('boom'); } });
  const out2 = await fallback.classify('what?');
  assert.equal(out2.kind, 'question');
}

// ---- Planner ----
{
  const plan = createPlan({ goal: 'Ship feature', steps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', dependsOn: ['a'] }, { id: 'c', title: 'C', dependsOn: ['a'] }] });
  assert.equal(plan.status, PLAN_STATUS.ready);
  assert.deepEqual(getReadySteps(plan).map((s) => s.id), ['a']);
  assert.equal(validatePlan(plan).ok, true);
  updateStep(plan, 'a', { status: STEP_STATUS.running });
  assert.equal(plan.status, PLAN_STATUS.running);
  updateStep(plan, 'a', { status: STEP_STATUS.completed, result: 'ok' });
  const ready = getReadySteps(plan).map((s) => s.id).sort();
  assert.deepEqual(ready, ['b', 'c']);
  updateStep(plan, 'b', { status: STEP_STATUS.completed });
  updateStep(plan, 'c', { status: STEP_STATUS.completed });
  assert.equal(isPlanComplete(plan), true);
  assert.equal(plan.status, PLAN_STATUS.completed);
}
{
  const bad = validatePlan({ goal: '', steps: [{ id: 'x', title: 'x', dependsOn: ['y'] }, { id: 'x', title: 'dup', dependsOn: [] }] });
  assert.equal(bad.ok, false);
}
{
  const plan = createPlan({ goal: 'g', steps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', dependsOn: ['a'] }] });
  updateStep(plan, 'a', { status: STEP_STATUS.failed, error: 'nope' });
  assert.equal(plan.status, PLAN_STATUS.failed);
  refreshPlan(plan);
  assert.equal(plan.steps.find((s) => s.id === 'b').status, STEP_STATUS.blocked);
}
{
  const plan = createPlan({ goal: 'g', steps: [{ id: 'a', title: 'A' }] });
  cancelPlan(plan, 'stop');
  assert.equal(plan.status, PLAN_STATUS.cancelled);
  assert.equal(isPlanTerminal(plan), true);
}

// ---- Router: allow/deny, missing metadata, insufficient permission, args, safety ----
{
  const tool = { name: 'read_file', parameters: { shape: { path: { isOptional: () => false } } }, execute: async () => 'ok', ...meta('assist') };
  const denied = routeToolCall({ toolName: 'read_file', args: { path: 'x' }, tools: [tool], permissions: {} });
  assert.equal(denied.allowed, false); // deny by default
  const allowed = routeToolCall({ toolName: 'read_file', args: { path: 'x' }, tools: [tool], permissions: { allowTools: ['read_file'], grantedLevel: 'assist' } });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.tool.name, 'read_file');
  // Allowed by policy, but no level granted by the host: still denied (there is no default grant).
  const noGrant = routeToolCall({ toolName: 'read_file', args: { path: 'x' }, tools: [tool], permissions: { allowTools: ['read_file'] } });
  assert.equal(noGrant.allowed, false);
  assert.match(noGrant.reason, /missing host permission level/);
  // A level name from the old three-step model is not a grant either.
  const oldName = routeToolCall({ toolName: 'read_file', args: { path: 'x' }, tools: [tool], permissions: { allowTools: ['read_file'], grantedLevel: 'high' } });
  assert.equal(oldName.allowed, false);
  assert.match(oldName.reason, /invalid host permission level/);
  const unknown = routeToolCall({ toolName: 'nope', args: {}, tools: [tool], permissions: { allow: true, grantedLevel: 'sensitive' } });
  assert.equal(unknown.allowed, false);
  const denyListed = routeToolCall({ toolName: 'read_file', args: { path: 'x' }, tools: [tool], permissions: { allow: true, denyTools: ['read_file'] } });
  assert.equal(denyListed.allowed, false);
  const badArgs = routeToolCall({ toolName: 'read_file', args: {}, tools: [tool], permissions: { allow: true, grantedLevel: 'sensitive' } });
  assert.equal(badArgs.allowed, false);
  assert.match(badArgs.reason, /invalid args/);
}
{
  const tool = { name: 'run_command', execute: async () => {}, ...meta('sensitive') };
  const safetyDenied = routeToolCall({
    toolName: 'run_command', args: { command: 'rm -rf /' }, tools: [tool], permissions: { allow: true, grantedLevel: 'sensitive' },
    safety: { preflight: () => ({ ok: false, reason: 'blocked by safety' }) },
  });
  assert.equal(safetyDenied.allowed, false);
  assert.match(safetyDenied.reason, /blocked by safety/);
  // metadata doesn't require approval by itself here, but policy can
  const approval2 = routeToolCall({ toolName: 'run_command', args: { command: 'echo hi' }, tools: [tool], permissions: { allow: true, grantedLevel: 'sensitive', requireApproval: ['run_command'] } });
  assert.equal(approval2.allowed, true);
  assert.equal(approval2.requiresApproval, true);
}
{
  const tool = { name: 'x', execute: async () => {}, ...meta('assist') };
  const router = createRouter({ tools: [tool], permissions: { allowTools: new Set(['x']), grantedLevel: 'assist' } });
  assert.deepEqual(router.listTools(), ['x']);
  assert.equal(router.route('x', {}).allowed, true);
  assert.equal(router.route('y', {}).allowed, false);
}
// Missing permission metadata denied (strict)
{
  const tool = { name: 'no_meta', execute: async () => 1 };
  const r = routeToolCall({ toolName: 'no_meta', args: {}, tools: [tool], permissions: { allow: true, grantedLevel: 'assist' } });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /missing permission metadata/);
}
// Insufficient permission level
{
  const tool = { name: 'write_file', execute: async () => 1, ...meta('trusted') };
  const r = routeToolCall({ toolName: 'write_file', args: {}, tools: [tool], permissions: { allow: true, grantedLevel: 'assist' } });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /insufficient permission level/);
}
// LLM intent cannot authorize execution
{
  const tool = { name: 'secret', execute: async () => 'x', ...meta('sensitive', true) };
  const r = routeToolCall({ toolName: 'secret', args: {}, tools: [tool], permissions: { allow: true, grantedLevel: 'sensitive' }, intent: { kind: 'command', risk: 'low', authorized: true, grant: true } });
  assert.equal(r.allowed, true); // policy allows
  assert.equal(r.requiresApproval, true); // intent did not remove approval
}

// ---- Executor: approval pause/resume, bound approvals, cancel, logs, deny, recheck ----
{
  const tool = { name: 'do', execute: async ({ v }) => v + 1, ...meta('assist', true) };
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 'S1', tool: 'do', args: { v: 1 } }] });
  const logs = [];
  const exec = createExecutor({
    logger: (e) => logs.push(e.type),
    requestApproval: async ({ request }) => ({ approved: true, requestId: request.id, fingerprint: request.fingerprint, toolName: request.toolName }),
    runTool: async ({ tool, args }) => tool.execute(args),
  });
  const router = createRouter({ tools: [tool], permissions: { allow: true, grantedLevel: 'sensitive' } });
  await exec.executeStep(plan, plan.steps[0], { router });
  assert.equal(plan.steps[0].status, STEP_STATUS.completed);
  assert.equal(plan.steps[0].result, 2);
  assert.ok(logs.includes('approval_requested'));
  assert.ok(logs.includes('approval_granted'));
  assert.ok(logs.includes('step_completed'));
}
{
  const tool = { name: 'do', execute: async () => 'x', ...meta('assist', true) };
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 'S1', tool: 'do', args: {} }] });
  const exec = createExecutor({ requestApproval: async () => false, runTool: async () => 'x' });
  const router = createRouter({ tools: [tool], permissions: { allow: true, grantedLevel: 'sensitive' } });
  await exec.executeStep(plan, plan.steps[0], { router });
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /denied|no approval/);
}
{
  const tool = { name: 'slow', execute: async () => {}, ...meta('assist') };
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 'S1', tool: 'slow', args: {} }] });
  let started;
  const exec = createExecutor({
    runTool: async ({ signal }) => new Promise((_, rej) => { started = true; signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }); }),
  });
  const router = createRouter({ tools: [tool], permissions: { allow: true, grantedLevel: 'sensitive' } });
  const p = exec.executeStep(plan, plan.steps[0], { router });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(started, true);
  exec.cancel('user stop');
  await p;
  assert.equal(plan.steps[0].status, STEP_STATUS.cancelled);
  assert.ok(exec.getLogs().some((e) => e.type === 'cancel_requested'));
}
{
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 'S1', tool: 'nope', args: {} }] });
  const exec = createExecutor({ runTool: async () => 'x' });
  const router = createRouter({ tools: [], permissions: { allow: true, grantedLevel: 'sensitive' } });
  await exec.executeStep(plan, plan.steps[0], { router });
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /unknown tool|denied/);
}
// Safety rechecked immediately before execution
{
  let calls = 0;
  const tool = { name: 'risky', execute: async () => 'ran', ...meta('sensitive') };
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 'S1', tool: 'risky', args: { a: 1 } }] });
  let ran = false;
  const exec = createExecutor({ runTool: async () => { ran = true; return 'ran'; } });
  const router = createRouter({
    tools: [tool],
    permissions: { allow: true, grantedLevel: 'sensitive' },
    safety: { preflight: ({ phase }) => { calls++; if (phase === 'pre_execute') return { ok: false, reason: 'late safety veto' }; return null; } },
  });
  await exec.executeStep(plan, plan.steps[0], { router });
  assert.equal(ran, false);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /late safety veto/);
  assert.ok(calls >= 2);
}
// Approval for one argument set cannot authorize another / stale+recheck binding
{
  const tool = { name: 'do', execute: async ({ x }) => x, ...meta('trusted', true) };
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 'S1', tool: 'do', args: { x: 1 } }] });
  let ran = false;
  const exec = createExecutor({
    requestApproval: async ({ request }) => ({ approved: true, requestId: request.id, fingerprint: request.fingerprint }),
    runTool: async ({ args }) => { ran = true; return args.x; },
  });
  // Router normalizes args differently at pre_execute to simulate mismatch/staleness.
  let phase = 0;
  const router = createRouter({
    tools: [tool],
    permissions: {
      allow: true,
      grantedLevel: 'sensitive',
      normalizeArgs: ({ args }) => {
        phase++;
        return phase <= 1 ? { x: 1 } : { x: 2 };
      },
    },
  });
  await exec.executeStep(plan, plan.steps[0], { router });
  assert.equal(ran, false);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
  assert.match(plan.steps[0].error, /mismatch|denied/);
}
// Cancellation prevents subsequent steps
{
  const calls = [];
  const tool = { name: 'do', execute: async ({ id }) => { calls.push(id); return id; }, ...meta('assist') };
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 'S1', tool: 'do', args: { id: 1 } }, { id: 's2', title: 'S2', tool: 'do', args: { id: 2 }, dependsOn: ['s1'] }] });
  const exec = createExecutor({ runTool: async ({ tool, args }) => tool.execute(args) });
  const router = createRouter({ tools: [tool], permissions: { allow: true, grantedLevel: 'sensitive' } });
  exec.cancel('stop');
  await exec.runReadySteps(plan, { router }, { maxSteps: 5 });
  assert.deepEqual(calls, []);
}
// Failed authorization cannot mark a step completed
{
  const tool = { name: 'do', execute: async () => 'ok', ...meta('assist', true) };
  const plan = createPlan({ goal: 'g', steps: [{ id: 's1', title: 'S1', tool: 'do', args: {} }] });
  const exec = createExecutor({ requestApproval: async () => ({ approved: false, reason: 'no' }), runTool: async () => 'ok' });
  const router = createRouter({ tools: [tool], permissions: { allow: true, grantedLevel: 'sensitive' } });
  await exec.executeStep(plan, plan.steps[0], { router });
  assert.notEqual(plan.steps[0].status, STEP_STATUS.completed);
  assert.equal(plan.steps[0].status, STEP_STATUS.failed);
}

// ---- Context budgeting / compatibility with store interfaces ----
{
  const msgs = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'x'.repeat(200)}` }));
  const fitted = budgetMessages(msgs, { budgetTokens: 2000, replyReserveTokens: 200 });
  assert.ok(Array.isArray(fitted));
  assert.ok(estimateTokens(fitted) <= estimateTokens(msgs));
  assert.equal(typeof approxTokens(msgs), 'number');
  const direct = fitContext(msgs, { budgetTokens: 500 });
  assert.ok(Array.isArray(direct));
}
{
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'remember to buy milk' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'what is 2+2?' },
  ];
  const sel = selectRelevantContext(msgs, { query: 'milk', intent: { category: 'memory' }, maxMessages: 3 });
  assert.ok(sel.some((m) => /milk/.test(m.content)));
  assert.ok(sel.some((m) => m.role === 'system'));
  const prepped = prepareContext(msgs, { query: 'milk', budgetTokens: 5000, replyReserveTokens: 200, maxMessages: 3 });
  assert.ok(prepped.messages.length <= 3);
  assert.equal(typeof prepped.stats.estimatedTokens, 'number');
}
{
  const msgs = [{ role: 'user', content: 'hi' }];
  const adapted = adaptHistoryForProvider(msgs, 'a', 'b');
  assert.ok(Array.isArray(adapted));
  assert.ok(Array.isArray(forProvider(msgs, 'a', 'b')));
}

// ---- Feature flag + factory ----
{
  // On by default since V2.1 (Batch 1): the safe path is the one everybody is on.
  assert.equal(isAgentCoreEnabled({}), true);
  assert.equal(isAgentCoreEnabled({ [AGENT_CORE_FLAG]: '' }), true);
  assert.equal(isAgentCoreEnabled({ [AGENT_CORE_FLAG]: '0' }), false);
  assert.equal(isAgentCoreEnabled({ [AGENT_CORE_FLAG]: 'false' }), false);
  assert.equal(isAgentCoreEnabled({ [AGENT_CORE_FLAG]: 'off' }), false);
  assert.equal(isAgentCoreEnabled({ [AGENT_CORE_FLAG]: '1' }), true);
  assert.equal(isAgentCoreEnabled({ [AGENT_CORE_FLAG]: 'true' }), true);
  const coreByDefault = createAgentCore({ env: {} });
  assert.equal(coreByDefault.enabled, true);
  const coreOff = createAgentCore({ env: { [AGENT_CORE_FLAG]: '0' } });
  assert.equal(coreOff.enabled, false);
  assert.deepEqual(coreOff.observe({ text: 'hello' }), { enabled: false });
  const coreOn = createAgentCore({ env: { [AGENT_CORE_FLAG]: '1' } });
  assert.equal(coreOn.enabled, true);
  const obs = coreOn.observe({ text: 'what is this?' });
  assert.equal(obs.enabled, true);
  assert.equal(obs.intent.kind, 'question');
  assert.equal(typeof coreOn.router.route, 'function');
  assert.equal(typeof coreOn.executor.executeStep, 'function');
  assert.equal(typeof coreOn.context.prepareContext, 'function');
  assert.ok(coreOn.approvals);
  assert.equal(coreOn.permissions.PERMISSION_LEVEL.observe, PERMISSION_LEVEL.observe);
  assert.equal(coreOn.permissions.PERMISSION_LEVEL.administrative, PERMISSION_LEVEL.administrative);
  assert.equal(coreOn.permissions.grantedLevel, null); // fail closed: no implicit grant
}

console.log('agentcore: passed');
