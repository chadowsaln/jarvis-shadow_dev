// Intent recognition for the agent core (Batch 1: heuristics + pluggable hook).
// Classifies user input into kinds/categories and attaches risk hints for routing.
// This module never grants execution permission; routing/executor enforce policy.

const QUESTION_START = /^(what|who|when|where|why|how|is|are|was|were|do|does|did|can|could|would|should|will|may|might|am|have|has|had)\b/i;
const COMMAND_HINT = /^(run|open|show|find|search|list|read|write|create|make|build|delete|remove|move|copy|install|start|stop|send|reply|edit|fix|change|update|add|set|check|test|summarize|explain|translate)\b/i;
const TASK_HINT = /\b(and then|after that|step by step|plan|multiple|batch|refactor|migrate|implement|debug|investigate|deploy|set up|configure)\b/i;
const SYSTEM_RISK = /\b(rm\b|delete|remove|install|sudo|chmod|chown|kill|format|deploy|push|publish|overwrite|shutdown|reboot)\b/i;
const WRITE_RISK = /\b(write|edit|change|update|rename|move|create|save)\b/i;

/** @typedef {'question'|'command'|'task'|'chat'} IntentKind */
/** @typedef {'low'|'medium'|'high'} RiskHint */

/**
 * Classify a user message. Pure and deterministic by default.
 * @param {string} text
 * @param {{ context?: object, llmClassify?: (text: string, base: object) => Promise<object|null> }} [opts]
 */
export function classifyIntent(text, opts = {}) {
  const raw = String(text ?? '').trim();
  const lower = raw.toLowerCase();
  const signals = [];

  const hasQuestionMark = /\?\s*$/.test(raw);
  if (hasQuestionMark) signals.push('question_mark');
  if (QUESTION_START.test(raw)) signals.push('question_start');
  if (COMMAND_HINT.test(raw)) signals.push('command_verb');
  if (TASK_HINT.test(lower)) signals.push('task_language');
  if (SYSTEM_RISK.test(lower)) signals.push('system_risk_term');
  if (WRITE_RISK.test(lower)) signals.push('write_risk_term');

  let kind = 'chat';
  if (hasQuestionMark || QUESTION_START.test(raw)) kind = 'question';
  if (COMMAND_HINT.test(raw)) kind = 'command';
  if (TASK_HINT.test(lower) || (COMMAND_HINT.test(raw) && /\band\b|,/.test(lower))) kind = kind === 'question' ? 'question' : 'task';

  /** @type {RiskHint} */
  let risk = 'low';
  if (WRITE_RISK.test(lower)) risk = 'medium';
  if (SYSTEM_RISK.test(lower)) risk = 'high';

  let category = 'general';
  if (/\b(file|folder|directory|path|read|write|edit)\b/.test(lower)) category = 'files';
  else if (/\b(run|command|terminal|shell|script|build|test)\b/.test(lower)) category = 'execution';
  else if (/\b(open|app|window|click|type|screen)\b/.test(lower)) category = 'interaction';
  else if (/\b(web|url|search|browse|http)\b/.test(lower)) category = 'web';
  else if (/\b(remember|memory|note|commitment)\b/.test(lower)) category = 'memory';

  const confidence = signals.length === 0 ? 0.35 : Math.min(0.95, 0.45 + signals.length * 0.12);
  return { kind, category, confidence: Number(confidence.toFixed(2)), risk, signals, text: raw };
}

/**
 * Create an intent classifier with an optional async LLM refinement hook.
 * Hook may return a partial override object; failures fall back to heuristics.
 */
export function createIntentClassifier({ llmClassify = null } = {}) {
  return {
    async classify(text, ctx = {}) {
      const base = classifyIntent(text, ctx);
      if (typeof llmClassify !== 'function') return base;
      try {
        const extra = await llmClassify(text, base);
        if (!extra || typeof extra !== 'object') return base;
        // Only allow known, non-authorizing fields from hook.
        const out = { ...base };
        if (['question', 'command', 'task', 'chat'].includes(extra.kind)) out.kind = extra.kind;
        if (typeof extra.category === 'string' && extra.category) out.category = extra.category.slice(0, 64);
        if (['low', 'medium', 'high'].includes(extra.risk)) out.risk = extra.risk;
        if (Number.isFinite(extra.confidence)) out.confidence = Math.max(0, Math.min(1, extra.confidence));
        if (Array.isArray(extra.signals)) out.signals = [...base.signals, ...extra.signals.filter((s) => typeof s === 'string')];
        return out;
      } catch {
        return base;
      }
    },
  };
}
