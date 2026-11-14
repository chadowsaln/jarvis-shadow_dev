// Agent Core runtime: the one way a tool call reaches a real tool when ROAMIES_AGENT_CORE is on.
//
// The chat's tool list is replaced by these wrappers, so the model's tool call is only a request:
// it goes through the router (policy + permission level + safety), then the executor (approval bound
// to the exact action, recheck, single-use consumption), and only then the tool's own execute().
// There is no path from the model to a tool that skips this, because the raw execute functions are
// replaced in the list handed to the agent. The raw tool stays reachable only through a private
// symbol, which the executor's runTool uses - the wrappers the router sees never run twice.

import { createPlan } from './planner.mjs';
import { createAgentCore } from './index.mjs';
import { defaultToolPermission, normalizePermissionLevel } from './permissions.mjs';

const RAW = Symbol('rawTool');
let stepSeq = 0;

function wrap(tool, getCore) {
  return {
    ...tool,
    [RAW]: tool,
    execute: async (args = {}, ctx = {}) => {
      const core = getCore();
      if (!core) throw new Error('Blocked: agent core is not ready');
      const stepId = `s${++stepSeq}`;
      const plan = createPlan({ goal: `call ${tool.name}`, steps: [{ id: stepId, title: tool.name, tool: tool.name, args: args ?? {} }] });
      const step = plan.steps[0];
      const out = await core.executor.executeStep(plan, step, { router: core.router, signal: ctx?.signal });
      if (out.status === 'completed') return out.result;
      const why = out.reason || step.error || out.status;
      const err = new Error(`Blocked: ${why}`);
      err.code = 'AGENTCORE_DENIED';
      err.status = out.status;
      throw err;
    },
  };
}

/** Wrap an existing authorized core's tools (used by tests and by anything building the core itself). */
export function guardTools({ tools = [], core } = {}) {
  if (!core) throw new Error('guardTools needs an agent core');
  return tools.map((t) => wrap(t, () => core));
}

/**
 * Build the agent core for the live app: policy from the environment, approvals over a channel,
 * tools wrapped so nothing bypasses authorization.
 *
 * ROAMIES_AGENT_CORE_LEVEL sets the host grant (observe | assist | trusted | sensitive | administrative).
 * It defaults to `observe`: read-only tools only. An unknown value grants nothing rather than more.
 * ROAMIES_AGENT_CORE_APPROVE="tool,tool" asks the person first, every time, for those tools. Off by default:
 * it is how the approval path is exercised before any tool that needs it exists.
 */
export function createAgentCoreRuntime({
  tools = [],
  env = process.env,
  approvalChannel = null,
  safety = null,
  logger = null,
  allowTools = null,
  requireApproval = null,
  grantedLevel = null,
} = {}) {
  const rawLevel = grantedLevel ?? env?.ROAMIES_AGENT_CORE_LEVEL ?? 'observe';
  const level = normalizePermissionLevel(rawLevel);
  // Only tools that declare what they may do are offered at all: the router denies anything without metadata, and
  // a tool the model can see but can never call is only noise. What is offered is the tools' own least privilege.
  const eligible = tools.filter((t) => t && t.name && defaultToolPermission(t));
  // The person answers each call of these, every time, even at a level that would not need it.
  const askNames = new Set((Array.isArray(requireApproval) ? requireApproval : String(env?.ROAMIES_AGENT_CORE_APPROVE ?? '').split(','))
    .map((s) => String(s ?? '').trim()).filter(Boolean));
  // An explicit allowlist on top of the metadata: a name not in it is never offered, even if the tool has metadata.
  const only = Array.isArray(allowTools) ? new Set(allowTools) : null;
  const offered = only ? eligible.filter((t) => only.has(t.name)) : eligible;
  let core = null;
  const curried = offered.map((t) => wrap(t, () => core));

  core = createAgentCore({
    enabled: true,
    tools: curried,
    permissions: {
      grantedLevel: level,
      strictPermissions: true,
      // Metadata is the allowlist: allow by default inside this list (the router has already required metadata).
      allowTools: ({ permissionMeta }) => !!permissionMeta,
      requireApproval: askNames.size ? ({ toolName }) => askNames.has(toolName) : null,
      approvalContext: null,
    },
    safety: safety ?? {},
    logger,
    requestApproval: approvalChannel ? (input) => approvalChannel.request(input) : undefined,
    // Authorize the wrapper, execute the real tool behind it.
    runTool: async ({ tool, args }) => {
      const real = tool?.[RAW] ?? null;
      if (!real || typeof real.execute !== 'function') throw new Error('tool is not executable');
      return real.execute(args ?? {});
    },
  });

  return {
    core,
    tools: curried,
    grantedLevel: level,
    /** Tools left out because they carry no permission metadata (never reachable while the flag is on). */
    skipped: tools.length - offered.length,
    asked: [...askNames],
    /** Set when the configured level is not one of the five: nothing may run. */
    levelError: level ? null : `unknown ROAMIES_AGENT_CORE_LEVEL: ${String(rawLevel)}`,
  };
}
