// Task planner for the agent core (Batch 1).
// Manages plan/step state; does not execute tools.

let nextPlan = 1;
let nextStep = 1;

export const PLAN_STATUS = Object.freeze({
  draft: 'draft',
  ready: 'ready',
  running: 'running',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
});

export const STEP_STATUS = Object.freeze({
  pending: 'pending',
  ready: 'ready',
  running: 'running',
  blocked: 'blocked',
  waiting_approval: 'waiting_approval',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
  cancelled: 'cancelled',
});

const TERMINAL_PLAN = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_STEP = new Set(['completed', 'failed', 'skipped', 'cancelled']);

function makeStep(input, index) {
  const title = String(input?.title ?? input?.name ?? `Step ${index + 1}`).trim();
  if (!title) throw new Error('step title is required');
  const dependsOn = Array.isArray(input?.dependsOn) ? input.dependsOn.map(String) : [];
  return {
    id: String(input?.id ?? `s${nextStep++}`),
    title,
    status: STEP_STATUS.pending,
    dependsOn,
    tool: input?.tool ? String(input.tool) : null,
    args: input?.args && typeof input.args === 'object' ? { ...input.args } : null,
    result: null,
    error: null,
    attempts: 0,
    meta: input?.meta && typeof input.meta === 'object' ? { ...input.meta } : {},
  };
}

export function createPlan({ goal, steps = [], meta = {} } = {}) {
  const g = String(goal ?? '').trim();
  if (!g) throw new Error('plan goal is required');
  if (!Array.isArray(steps)) throw new Error('steps must be an array');
  const plan = {
    id: `p${nextPlan++}`,
    goal: g,
    status: PLAN_STATUS.draft,
    steps: steps.map(makeStep),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    meta: meta && typeof meta === 'object' ? { ...meta } : {},
  };
  return refreshPlan(plan);
}

export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan must be an object'] };
  if (!String(plan.goal ?? '').trim()) errors.push('goal is required');
  if (!Array.isArray(plan.steps)) errors.push('steps must be an array');
  const ids = new Set();
  for (const s of plan.steps || []) {
    if (!s || !String(s.id ?? '').trim()) errors.push('step id is required');
    if (!String(s.title ?? '').trim()) errors.push(`step ${s?.id ?? '?'}: title is required`);
    if (ids.has(s.id)) errors.push(`duplicate step id: ${s.id}`);
    ids.add(s.id);
    if (!Object.values(STEP_STATUS).includes(s.status)) errors.push(`step ${s.id}: invalid status`);
  }
  for (const s of plan.steps || []) {
    for (const dep of s.dependsOn || []) {
      if (!ids.has(dep)) errors.push(`step ${s.id}: unknown dependency ${dep}`);
      if (dep === s.id) errors.push(`step ${s.id}: cannot depend on itself`);
    }
  }
  if (plan.status && !Object.values(PLAN_STATUS).includes(plan.status)) errors.push('invalid plan status');
  return { ok: errors.length === 0, errors };
}

function depsSatisfied(plan, step) {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  return (step.dependsOn || []).every((d) => byId.get(d)?.status === STEP_STATUS.completed);
}

export function getReadySteps(plan) {
  if (!plan || TERMINAL_PLAN.has(plan.status)) return [];
  return plan.steps.filter((s) => (s.status === STEP_STATUS.pending || s.status === STEP_STATUS.ready) && depsSatisfied(plan, s));
}

export function refreshPlan(plan) {
  for (const s of plan.steps) {
    if (s.status === STEP_STATUS.pending || s.status === STEP_STATUS.ready || s.status === STEP_STATUS.blocked) {
      const byId = new Map(plan.steps.map((x) => [x.id, x]));
      const blockedByFailure = (s.dependsOn || []).some((d) => ['failed', 'cancelled', 'skipped'].includes(byId.get(d)?.status));
      if (blockedByFailure) s.status = STEP_STATUS.blocked;
      else if (depsSatisfied(plan, s)) s.status = STEP_STATUS.ready;
      else s.status = STEP_STATUS.pending;
    }
  }
  if (!TERMINAL_PLAN.has(plan.status)) {
    if (plan.steps.length && plan.steps.every((s) => s.status === STEP_STATUS.completed)) plan.status = PLAN_STATUS.completed;
    else if (plan.steps.some((s) => s.status === STEP_STATUS.failed)) plan.status = PLAN_STATUS.failed;
    else if (plan.steps.some((s) => s.status === STEP_STATUS.running || s.status === STEP_STATUS.waiting_approval)) plan.status = sRunningStatus(plan);
    else if (plan.steps.some((s) => s.status === STEP_STATUS.ready)) plan.status = plan.status === PLAN_STATUS.running ? PLAN_STATUS.running : PLAN_STATUS.ready;
  }
  plan.updatedAt = Date.now();
  return plan;
}

function sRunningStatus(plan) {
  return plan.steps.some((s) => s.status === STEP_STATUS.waiting_approval) ? PLAN_STATUS.paused : PLAN_STATUS.running;
}

export function updateStep(plan, stepId, patch = {}) {
  const s = plan.steps.find((x) => x.id === stepId);
  if (!s) throw new Error(`unknown step: ${stepId}`);
  if (TERMINAL_STEP.has(s.status) && !patch.force) throw new Error(`cannot update terminal step: ${stepId}`);
  const allowed = ['status', 'result', 'error', 'attempts', 'tool', 'args', 'meta'];
  for (const k of allowed) {
    if (k in patch) s[k] = k === 'meta' && patch.meta ? { ...s.meta, ...patch.meta } : patch[k];
  }
  return refreshPlan(plan);
}

export function cancelPlan(plan, reason = 'cancelled') {
  if (TERMINAL_PLAN.has(plan.status)) return plan;
  for (const s of plan.steps) {
    if (!TERMINAL_STEP.has(s.status)) {
      s.status = STEP_STATUS.cancelled;
      s.error = s.error || reason;
    }
  }
  plan.status = PLAN_STATUS.cancelled;
  plan.updatedAt = Date.now();
  return plan;
}

export function isPlanComplete(plan) { return plan?.status === PLAN_STATUS.completed; }
export function isPlanTerminal(plan) { return TERMINAL_PLAN.has(plan?.status); }
