import assert from 'node:assert/strict';
import { AuthStorage } from '@kenkaiiii/gg-core';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseGeminiCatalog,
  discoverGeminiModels,
  validateGeminiKey,
  seedEnvGeminiKey,
  clearGeminiCache,
} from '../google-aistudio.mjs';

clearGeminiCache();

// 1. parseGeminiCatalog
{
  const mockData = {
    models: [
      {
        name: 'models/gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        inputTokenLimit: 2097152,
        outputTokenLimit: 65536,
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/text-embedding-004',
        displayName: 'Text Embedding 004',
        supportedGenerationMethods: ['embedContent'],
      },
    ],
  };

  const { models, skipped } = parseGeminiCatalog(mockData);
  assert.equal(models.length, 2, '2 conversational models kept');
  assert.equal(skipped, 1, '1 embedding model skipped');
  assert.equal(models[0].id, 'gemini-2.5-flash');
  assert.equal(models[0].provider, 'gemini');
  assert.equal(models[0].costTier, 'low');
  assert.equal(models[1].id, 'gemini-2.5-pro');
  assert.equal(models[1].costTier, 'high');
  assert.deepEqual(models[0].authStorageKeys, ['gemini-api']);
}

// 2. discoverGeminiModels and validateGeminiKey
{
  const fakeFetch = async (url) => {
    const u = new URL(url);
    const key = u.searchParams.get('key');
    if (key === 'bad-key') {
      return { status: 400, ok: false, json: async () => ({ error: { message: 'API key not valid' } }) };
    }
    if (key === 'rate-limited') {
      return { status: 429, ok: false, json: async () => ({ error: { message: 'Quota exceeded' } }) };
    }
    return {
      status: 200,
      ok: true,
      json: async () => ({
        models: [
          {
            name: 'models/gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      }),
    };
  };

  // Valid key
  const valid = await validateGeminiKey('good-key', { fetchImpl: fakeFetch });
  assert.equal(valid.ok, true);
  assert.equal(valid.models.length, 1);
  assert.equal(valid.models[0].id, 'gemini-2.5-flash');

  const discovered = await discoverGeminiModels('good-key', { fetchImpl: fakeFetch });
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].id, 'gemini-2.5-flash');

  // Invalid key
  const invalid = await validateGeminiKey('bad-key', { fetchImpl: fakeFetch });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'key');
  assert.equal(invalid.status, 401);

  await assert.rejects(
    () => discoverGeminiModels('bad-key', { fetchImpl: fakeFetch, fresh: true }),
    /gemini_invalid_key/
  );

  // Rate limited
  const limited = await validateGeminiKey('rate-limited', { fetchImpl: fakeFetch });
  assert.equal(limited.ok, false);
  assert.equal(limited.reason, 'rate_limited');
  assert.equal(limited.status, 429);
}

// 3. seedEnvGeminiKey
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-auth-test-'));
  const authFile = path.join(dir, 'auth.json');
  const auth = new AuthStorage(authFile);

  const env = { GEMINI_API_KEY: 'AIzaSyTestEnvKey123' };
  const seeded = await seedEnvGeminiKey(auth, { env });
  assert.equal(seeded, 'AIzaSyTestEnvKey123');

  const has = await auth.hasCredentials('gemini-api');
  assert.equal(has, true);

  const creds = await auth.getCredentials('gemini-api');
  assert.equal(creds.accessToken, 'AIzaSyTestEnvKey123');

  await fs.rm(dir, { recursive: true, force: true });
}

console.log('google-aistudio tests: passed');
