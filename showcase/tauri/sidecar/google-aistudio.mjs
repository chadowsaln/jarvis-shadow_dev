// Google AI Studio model discovery, key validation, and environment key management.
// Fetches the live Google AI Studio catalog from https://generativelanguage.googleapis.com/v1beta/models?key=...
// so JARVIS V2 can run any Gemini model (Gemini 2.5 Pro/Flash, 2.0, 1.5, 3.x, etc.) with real-time discovery.

import { keyFingerprint } from './openrouter.mjs';

export const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const TTL = 10 * 60 * 1000;

let cache = { models: null, at: 0, key: null };

/**
 * Parses Google AI Studio model list into gg-core ModelInfo objects.
 * Filters for models that support text/content generation.
 */
export function parseGeminiCatalog(data) {
  const rawList = Array.isArray(data?.models) ? data.models : [];
  const models = [];
  let skipped = 0;

  for (const m of rawList) {
    const rawName = String(m?.name ?? '');
    const id = rawName.replace(/^models\//, '').trim();
    if (!id) { skipped++; continue; }

    const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
    const canGenerate = methods.includes('generateContent') || methods.length === 0;
    // Skip embedding-only or image-generation only models for conversational agent
    if (!canGenerate && (id.includes('embedding') || id.includes('imagen') || id.includes('aqa'))) {
      skipped++;
      continue;
    }

    const inputTokens = Number(m?.inputTokenLimit);
    const outputTokens = Number(m?.outputTokenLimit);
    const isPro = id.toLowerCase().includes('pro');

    models.push({
      id,
      name: m?.displayName?.trim() || id,
      provider: 'gemini',
      contextWindow: Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 1048576,
      maxOutputTokens: Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 65536,
      supportsThinking: true,
      supportsImages: true,
      supportsVideo: true,
      maxVideoBytes: 20971520,
      costTier: isPro ? 'high' : 'low',
      maxThinkingLevel: 'high',
      authStorageKeys: ['gemini-api'],
    });
  }

  // Sort: flash models first, then pro, then newest
  models.sort((a, b) => {
    const aFlash = a.id.includes('flash');
    const bFlash = b.id.includes('flash');
    if (aFlash && !bFlash) return -1;
    if (!aFlash && bFlash) return 1;
    return a.id.localeCompare(b.id);
  });

  return { models, skipped };
}

/**
 * Fetches the Google AI Studio catalog with the provided key.
 */
async function fetchGeminiCatalog(key, { signal, fetchImpl = globalThis.fetch } = {}) {
  const url = `${GEMINI_MODELS_URL}?key=${encodeURIComponent(key)}`;
  let res;
  try {
    res = await fetchImpl(url, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('gemini_network');
  }

  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new Error('gemini_invalid_key');
  }
  if (res.status === 429) {
    throw Object.assign(new Error('gemini_rate_limited'), { status: 429 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`gemini_${res.status}`), { status: res.status });
  }

  const data = await res.json();
  const parsed = parseGeminiCatalog(data);
  return { models: parsed.models, skipped: parsed.skipped };
}

/**
 * Fetch and parse Google AI Studio model catalog.
 */
export async function discoverGeminiModels(apiKey, { signal, fresh = false, fetchImpl } = {}) {
  if (!apiKey || typeof apiKey !== 'string') throw new Error('gemini_api_key_missing');
  const key = apiKey.trim();
  if (!key) throw new Error('gemini_api_key_missing');

  const print = keyFingerprint(key);
  const now = Date.now();
  if (!fresh && cache.models && cache.key === print && now - cache.at < TTL) {
    return cache.models.slice();
  }

  try {
    const { models } = await fetchGeminiCatalog(key, { signal, fetchImpl });
    cache = { models, at: now, key: print };
    return models.slice();
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (msg === 'gemini_invalid_key' || msg === 'gemini_api_key_missing') throw e;
    if (msg.startsWith('gemini_')) throw e;
    throw new Error('gemini_network');
  }
}

/**
 * Validate a Google AI Studio key before saving. Never throws.
 */
export async function validateGeminiKey(apiKey, { signal, fetchImpl } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return { ok: false, reason: 'key', status: null, models: [], skipped: 0 };
  try {
    const { models, skipped } = await fetchGeminiCatalog(key, { signal, fetchImpl });
    cache = { models, at: Date.now(), key: keyFingerprint(key) };
    return { ok: true, reason: null, status: null, models: models.slice(), skipped };
  } catch (e) {
    const msg = String(e?.message ?? e);
    const status = e?.status ?? (msg === 'gemini_rate_limited' ? 429 : null);
    if (msg === 'gemini_invalid_key') return { ok: false, reason: 'key', status: 401, models: [], skipped: 0 };
    if (msg === 'gemini_rate_limited') return { ok: false, reason: 'rate_limited', status: 429, models: [], skipped: 0 };
    if (msg.startsWith('gemini_') && status != null) return { ok: false, reason: 'http', status, models: [], skipped: 0 };
    return { ok: false, reason: 'network', status: null, models: [], skipped: 0 };
  }
}

/**
 * Auto-detects Gemini / Google AI Studio key from environment variables (GEMINI_API_KEY, GOOGLE_API_KEY).
 * If present and auth does not already have credentials, or if forced, stores credentials under 'gemini-api'.
 */
export async function seedEnvGeminiKey(auth, { env = process.env, force = false } = {}) {
  const key = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_AI_STUDIO_KEY || '').trim();
  if (!key) return null;

  const hasKey = await auth.hasCredentials('gemini-api').catch(() => false);
  if (!hasKey || force) {
    await auth.setCredentials('gemini-api', {
      accessToken: key,
      refreshToken: '',
      expiresAt: Date.now() + 100 * 365 * 864e5,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    });
    return key;
  }
  return key;
}

export function clearGeminiCache() {
  cache = { models: null, at: 0, key: null };
}
