// OpenRouter model discovery, key checks and per-model capability tests. Run: node test/openrouter.test.mjs
import assert from 'node:assert/strict';
import {
  discoverOpenRouterModels, clearOpenRouterCache, keyFingerprint, validateOpenRouterKey, openRouterModelInfo,
} from '../openrouter.mjs';

// A catalog shaped like OpenRouter's answer: two usable models, one without tools, one without a window.
const CATALOG = {
  data: [
    { id: 'qwen/qwen3-32b', name: 'Qwen3 32B', context_length: 32768, supported_parameters: ['tools'], pricing: { prompt: '0.0001' }, architecture: { input_modalities: ['text'] } },
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', context_length: 200000, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } },
    { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', context_length: null, supported_parameters: ['tools'] },
    { id: 'provider/no-tools', name: 'No tools', context_length: 32768, supported_parameters: [] },
  ],
};

// Replace global.fetch for one block; `seen` records each request the code made.
function withFetch(handler, fn) {
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return handler(url, opts, seen.length);
  };
  return Promise.resolve(fn(seen)).finally(() => { global.fetch = realFetch; clearOpenRouterCache(); });
}
const okCatalog = () => ({ status: 200, ok: true, json: async () => CATALOG });

clearOpenRouterCache();

// ---------- discovery ----------
await withFetch(okCatalog, async (seen) => {
  const models = await discoverOpenRouterModels('sk-or-v1-test');
  assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/models');
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer sk-or-v1-test');
  assert.equal(models.length, 2, 'models without tool support or a context window are excluded');
  assert.equal(models[0].id, 'qwen/qwen3-32b');
  assert.equal(models[0].provider, 'openrouter');
  assert.equal(models[0].contextWindow, 32768);
  assert.equal(models[0].maxOutputTokens, 16384);
  assert.equal(models[0].supportsImages, false, 'text-only model');
  assert.equal(models[1].name, 'Claude 3.5 Sonnet');
  assert.equal(models[1].supportsImages, true, 'vision model');
});

// A second discovery with the same key is a cache hit (no request).
await withFetch(okCatalog, async (seen) => {
  await discoverOpenRouterModels('sk-or-v1-same');
  await discoverOpenRouterModels('sk-or-v1-same');
  assert.equal(seen.length, 1, 'the same key reuses its catalog');
});

// A different key never sees the previous key's catalog: the request is made again, with the new key.
await withFetch(okCatalog, async (seen) => {
  await discoverOpenRouterModels('sk-or-v1-first');
  await discoverOpenRouterModels('sk-or-v1-second');
  assert.equal(seen.length, 2, 'a swapped key refetches');
  assert.equal(seen[1].opts.headers.Authorization, 'Bearer sk-or-v1-second');
  await discoverOpenRouterModels('sk-or-v1-first');
  assert.equal(seen.length, 3, 'going back to the first key refetches too: one entry, not one per key');
});

// fresh: true skips the cache.
await withFetch(okCatalog, async (seen) => {
  await discoverOpenRouterModels('sk-or-v1-fresh');
  await discoverOpenRouterModels('sk-or-v1-fresh', { fresh: true });
  assert.equal(seen.length, 2);
});

await withFetch(() => ({ status: 401, ok: false }), async () => {
  await assert.rejects(() => discoverOpenRouterModels('bad-key'), /openrouter_invalid_key/);
});
await withFetch(() => ({ status: 403, ok: false }), async () => {
  await assert.rejects(() => discoverOpenRouterModels('bad-key'), /openrouter_invalid_key/);
});
await withFetch(async () => { throw new Error('ENOTFOUND'); }, async () => {
  await assert.rejects(() => discoverOpenRouterModels('sk-or-v1-test'), /openrouter_network/);
});
await withFetch(() => ({ status: 200, ok: true, json: async () => ({ data: [] }) }), async () => {
  assert.equal((await discoverOpenRouterModels('sk-or-v1-test')).length, 0);
});
await assert.rejects(() => discoverOpenRouterModels(''), /openrouter_api_key_missing/);
await assert.rejects(() => discoverOpenRouterModels('   '), /openrouter_api_key_missing/, 'whitespace is not a key');

// ---------- key fingerprint ----------
assert.equal(keyFingerprint('sk-or-v1-abc'), keyFingerprint(' sk-or-v1-abc '), 'trimmed: the same key');
assert.notEqual(keyFingerprint('sk-or-v1-abc'), keyFingerprint('sk-or-v1-abd'));
assert.notEqual(keyFingerprint('short'), keyFingerprint('longer'));
assert.equal(keyFingerprint(''), '');
assert.ok(!keyFingerprint('sk-or-v1-secret').includes('sk-or-v1-secret'), 'the key is not recoverable from it');
assert.match(keyFingerprint('x'), /^[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/);

// ---------- validating a key before it is saved ----------
await withFetch(okCatalog, async () => {
  const r = await validateOpenRouterKey('sk-or-v1-good');
  assert.equal(r.ok, true);
  assert.equal(r.models.length, 2);
  assert.equal(r.skipped, 2, 'the two unusable models are counted, not silently assumed usable');
});
// Validation seeds the cache for that key, so saving it does not fetch twice.
await withFetch(okCatalog, async (seen) => {
  await validateOpenRouterKey('sk-or-v1-good');
  await discoverOpenRouterModels('sk-or-v1-good');
  assert.equal(seen.length, 1);
});
await withFetch(() => ({ status: 401, ok: false }), async () => {
  assert.deepEqual(await validateOpenRouterKey('bad'), { ok: false, reason: 'key', status: 401, models: [], skipped: 0 });
});
await withFetch(() => ({ status: 429, ok: false }), async () => {
  const r = await validateOpenRouterKey('rate-limited');
  assert.deepEqual(r, { ok: false, reason: 'rate_limited', status: 429, models: [], skipped: 0 });
});
await withFetch(() => ({ status: 429, ok: false }), async () => {
  await assert.rejects(() => discoverOpenRouterModels('sk-or-v1-rl'), /openrouter_rate_limited/);
});
await withFetch(() => ({ status: 402, ok: false }), async () => {
  const r = await validateOpenRouterKey('no-credit');
  assert.equal(r.ok, false); assert.equal(r.reason, 'http'); assert.equal(r.status, 402);
});
await withFetch(async () => { throw new Error('fetch failed'); }, async () => {
  const r = await validateOpenRouterKey('sk-or-v1-test');
  assert.equal(r.ok, false); assert.equal(r.reason, 'network');
});
assert.deepEqual(await validateOpenRouterKey(''), { ok: false, reason: 'key', status: null, models: [], skipped: 0 });
// Never throws, whatever the network did.
await withFetch(async () => { throw new TypeError('boom'); }, async () => {
  assert.equal((await validateOpenRouterKey('k')).ok, false);
});

// ---------- per-model capabilities (never assumed) ----------
const models = [
  { id: 'qwen/qwen3-32b', contextWindow: 32768, supportsImages: false },
  { id: 'anthropic/claude-3.5-sonnet', contextWindow: 200000, supportsImages: true },
];
assert.deepEqual(openRouterModelInfo('qwen/qwen3-32b', models), { id: 'qwen/qwen3-32b', known: true, supportsTools: true, supportsImages: false, contextWindow: 32768 });
assert.deepEqual(openRouterModelInfo('anthropic/claude-3.5-sonnet', models), { id: 'anthropic/claude-3.5-sonnet', known: true, supportsTools: true, supportsImages: true, contextWindow: 200000 });
// A hand-typed id the catalog doesn't list: unknown, not "yes".
const unknown = openRouterModelInfo('someone/brand-new', models);
assert.deepEqual(unknown, { id: 'someone/brand-new', known: false, supportsTools: null, supportsImages: null, contextWindow: null });
assert.equal(openRouterModelInfo('', models).known, false);
assert.equal(openRouterModelInfo('qwen/qwen3-32b', []).known, false, 'no catalog: unknown');

// The default catalog is the last one discovered with the current key.
await withFetch(okCatalog, async () => {
  await discoverOpenRouterModels('sk-or-v1-info');
  assert.deepEqual(openRouterModelInfo('qwen/qwen3-32b'), { id: 'qwen/qwen3-32b', known: true, supportsTools: true, supportsImages: false, contextWindow: 32768 });
  assert.equal(openRouterModelInfo('nope/nope').known, false);
});

console.log('openrouter ok');
