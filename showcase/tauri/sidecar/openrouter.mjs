// OpenRouter model discovery and key checks: https://openrouter.ai/api/v1/models
// Fetches the full OpenRouter model catalog using the account's API key,
// so Little Boy is never restricted to a hardcoded subset (e.g. Qwen only).
// The catalog is also the cheapest way to check a key: one authenticated GET, no paid tokens.
import { parseOpenRouterCatalog } from '@kenkaiiii/gg-core';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
// Keep a discovered catalog for ten minutes before refetching.
const TTL = 10 * 60 * 1000;

// The catalog belongs to the key that fetched it: swapping keys between accounts (or pasting a typo over a
// working key) must never serve the previous key's models. The cache therefore remembers a fingerprint of
// its key, never the key itself.
let cache = { models: null, at: 0, key: null };

/**
 * A stable, non-reversible fingerprint of an API key: same key → same string, and the key cannot be read
 * back from it. Only used to tell one key's cached catalog from another's (it is safe to log).
 */
export function keyFingerprint(apiKey) {
  const s = String(apiKey ?? '').trim();
  if (!s) return '';
  // FNV-1a, twice with different offsets, so collisions are practicably impossible for our use.
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `${s.length.toString(36)}-${a.toString(36)}-${b.toString(36)}`;
}

// One authenticated catalog fetch. Throws 'openrouter_invalid_key' when OpenRouter refuses the key.
async function fetchCatalog(key, signal) {
  const res = await fetch(OPENROUTER_MODELS_URL, {
    headers: { Authorization: `Bearer ${key}` },
    signal,
  });
  if (res.status === 401 || res.status === 403) throw new Error('openrouter_invalid_key');
  if (!res.ok) throw Object.assign(new Error(`openrouter_${res.status}`), { status: res.status });
  const data = await res.json();
  // gg-core's canonical parser: it drops models without tool calling or a context window, and maps
  // context, output limits, vision and reasoning into ModelInfo. Models it drops are counted, not assumed.
  const parsed = parseOpenRouterCatalog(data);
  return { models: parsed.models, skipped: parsed.skipped ?? 0 };
}

/**
 * Fetch and parse OpenRouter's model catalog. Throws on network or auth failure.
 * `fresh: true` skips the cache (a key check must not trust another moment's answer).
 */
export async function discoverOpenRouterModels(apiKey, { signal, fresh = false } = {}) {
  if (!apiKey || typeof apiKey !== 'string') throw new Error('openrouter_api_key_missing');
  const key = apiKey.trim();
  if (!key) throw new Error('openrouter_api_key_missing');
  const print = keyFingerprint(key);
  const now = Date.now();
  if (!fresh && cache.models && cache.key === print && now - cache.at < TTL) return cache.models.slice();
  try {
    const { models } = await fetchCatalog(key, signal);
    cache = { models, at: now, key: print };
    return models.slice();
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (msg === 'openrouter_invalid_key' || msg === 'openrouter_api_key_missing') throw e;
    if (msg.startsWith('openrouter_')) throw e;
    throw new Error('openrouter_network');
  }
}

/**
 * Check a key before it is saved: one catalog fetch with it. Never throws.
 * Resolves { ok: true, models, skipped } or { ok: false, reason: 'key'|'network'|'http', status }.
 * reason 'key' means OpenRouter refused the key itself (401/403); 'http' is anything else it answered.
 */
export async function validateOpenRouterKey(apiKey, { signal } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return { ok: false, reason: 'key', status: null, models: [], skipped: 0 };
  try {
    const { models, skipped } = await fetchCatalog(key, signal);
    cache = { models, at: Date.now(), key: keyFingerprint(key) };
    return { ok: true, reason: null, status: null, models: models.slice(), skipped };
  } catch (e) {
    const msg = String(e?.message ?? e);
    const status = e?.status ?? (msg === 'openrouter_invalid_key' ? 401 : null);
    if (msg === 'openrouter_invalid_key') return { ok: false, reason: 'key', status: 401, models: [], skipped: 0 };
    if (msg.startsWith('openrouter_') && status != null) return { ok: false, reason: 'http', status, models: [], skipped: 0 };
    return { ok: false, reason: 'network', status: null, models: [], skipped: 0 };
  }
}

/**
 * What the catalog knows about one model id. `supportsTools` and `supportsImages` are null when the id
 * isn't in the catalog (a hand-typed id): unknown is never reported as "yes".
 * Catalog models were filtered to those that support tools, so a known one always does.
 */
export function openRouterModelInfo(modelId, models = cache.models ?? []) {
  const id = String(modelId ?? '').trim();
  const hit = (models ?? []).find((m) => m && m.id === id);
  if (!hit) return { id, known: false, supportsTools: null, supportsImages: null, contextWindow: null };
  return {
    id,
    known: true,
    supportsTools: true,
    supportsImages: hit.supportsImages === true,
    contextWindow: Number.isFinite(hit.contextWindow) ? hit.contextWindow : null,
  };
}

/** Drop the cached catalog so the next discovery refetches from the API. */
export function clearOpenRouterCache() {
  cache = { models: null, at: 0, key: null };
}
