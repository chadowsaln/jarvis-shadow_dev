// Context management utilities for the agent core (Batch 1).
// Composes with existing store helpers (fitContext, approxTokens, forProvider) without duplicating them.

import { approxTokens, fitContext, forProvider } from '../store.mjs';

export function estimateTokens(messages) {
  return approxTokens(messages || []);
}

/**
 * Budget messages to a token ceiling using existing fitContext behavior.
 * @param {Array} messages
 * @param {{ budgetTokens?: number, force?: boolean, replyReserveTokens?: number }} opts
 */
export function budgetMessages(messages, opts = {}) {
  const rawBudget = opts.budgetTokens ?? opts.budget ?? process.env.ROAMIES_CONTEXT_BUDGET ?? 24000;
  const budgetTokens = Number(rawBudget);
  const rawReserve = opts.replyReserveTokens ?? opts.replyReserve ?? 0;
  const reserve = Number(rawReserve);
  const ceiling = Math.max(500, (Number.isFinite(budgetTokens) ? budgetTokens : 24000) - (Number.isFinite(reserve) ? reserve : 0));
  return fitContext(messages || [], { budgetTokens: ceiling, force: !!opts.force });
}

/**
 * Select context relevant to a query/intent. Deterministic heuristic baseline:
 * keeps system/most recent messages and messages containing overlapping terms.
 */
export function selectRelevantContext(messages = [], { query = '', intent = null, maxMessages = 40 } = {}) {
  if (!Array.isArray(messages)) return [];
  const terms = String(query || intent?.text || '').toLowerCase().split(/[^a-z0-9\u0600-\u06ff]+/).filter((t) => t.length > 2);
  const scored = messages.map((m, i) => {
    const text = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
    const lower = text.toLowerCase();
    let score = i / Math.max(1, messages.length); // recency bias
    if (m?.role === 'system') score += 5;
    if (m?.role === 'tool') score += 0.2;
    for (const t of terms) if (lower.includes(t)) score += 0.6;
    if (intent?.category === 'memory' && /remember|memory|fact|commitment/.test(lower)) score += 0.8;
    return { m, i, score };
  });
  scored.sort((a, b) => b.score - a.score || b.i - a.i);
  const picked = new Set(scored.slice(0, Math.max(1, maxMessages)).map((x) => x.i));
  return messages.filter((_, i) => picked.has(i));
}

/** Provider-safe history conversion (delegates to store.forProvider). */
export function adaptHistoryForProvider(messages, from, to) {
  return forProvider(messages || [], from, to);
}

/** Compose selection + budgeting for a single context preparation step. */
export function prepareContext(messages, { query = '', intent = null, budgetTokens, replyReserveTokens, maxMessages = 40, force = false } = {}) {
  const selected = selectRelevantContext(messages, { query, intent, maxMessages });
  const fitted = budgetMessages(selected, { budgetTokens, replyReserveTokens, force });
  return {
    messages: fitted,
    stats: {
      inputMessages: Array.isArray(messages) ? messages.length : 0,
      selectedMessages: selected.length,
      outputMessages: Array.isArray(fitted) ? fitted.length : 0,
      estimatedTokens: estimateTokens(fitted),
    },
  };
}
