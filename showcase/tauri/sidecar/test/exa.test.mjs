// Exa integration tests (Batch 11): mock-only, no network, no API key required.
// Run: node showcase/tauri/sidecar/test/exa.test.mjs
import assert from 'node:assert/strict';
import { exaStatus, exaSearch, exaGetContents, exaFindSimilar } from '../exa.mjs';
import { createTools } from '../tools.mjs';
import { describe } from '../activity.mjs';

console.log('exa tests: start');

// --- status / missing key (never asks for key, no network)
{
  const st = exaStatus({ env: {} });
  assert.equal(st.provider, 'exa');
  assert.equal(st.configured, false);
  assert.equal(st.status, 'not_configured');
  assert.ok(/EXA_API_KEY/.test(st.note) || /not configured/i.test(st.note));
  const st2 = exaStatus({ env: { EXA_API_KEY: '  secret-key  ' } });
  assert.equal(st2.configured, true);
  assert.equal(st2.status, 'configured');
  assert.ok(!JSON.stringify(st2).includes('secret-key'), 'status must not expose key');
  console.log('exa status/missing key: passed');
}

// --- search requires config and does not call fetch without key
{
  let called = 0;
  const r = await exaSearch({ query: 'hello' }, { env: {}, fetchImpl: async () => { called++; throw new Error('should not fetch'); } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'not_configured');
  assert.equal(called, 0);
  assert.ok(!JSON.stringify(r).includes('EXA_API_KEY='));
  console.log('exa no-key no-fetch: passed');
}

// --- search success normalization (Arabic/English), citations, limits, no key leak
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({
        results: [
          { title: 'مثال برمجي', url: 'https://example.com/ar', text: 'محتوى عربي عن البرمجة والذكاء الاصطناعي.', highlights: ['مقتطف عربي'] , author: 'A', publishedDate: '2026-01-01', score: 0.9 },
          { title: 'Tech News', url: 'https://news.example.com/x', highlights: ['English snippet about TypeScript and Node.js'], score: 0.8 },
        ],
      }),
    };
  };
  const r = await exaSearch({ query: 'أخبار برمجة TypeScript', numResults: 5 }, { env: { EXA_API_KEY: 'super-secret-key' }, fetchImpl, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok');
  assert.equal(r.provider, 'exa');
  assert.equal(r.count, 2);
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].title, 'مثال برمجي');
  assert.equal(r.results[0].url, 'https://example.com/ar');
  assert.ok(r.results[0].snippet.includes('مقتطف'));
  assert.equal(r.results[0].source, 'exa');
  assert.equal(r.citations[0].url, 'https://example.com/ar');
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0].url).endsWith('/search'));
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.query, 'أخبار برمجة TypeScript');
  assert.equal(calls[0].init.headers['x-api-key'], 'super-secret-key');
  assert.ok(!JSON.stringify(r).includes('super-secret-key'), 'result must not leak API key');
  assert.ok(r.results[0].content.length <= 20000);
  console.log('exa search normalization: passed');
}

// --- get contents normalization and maxCharacters bound
{
  let seenBody;
  const fetchImpl = async (_url, init) => {
    seenBody = JSON.parse(init.body);
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ results: [{ title: 'Page', url: 'https://example.com', text: 'body text', highlights: ['h1'] }] }) };
  };
  const r = await exaGetContents({ urls: ['https://example.com'], maxCharacters: 999999 }, { env: { EXA_API_KEY: 'k' }, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].url, 'https://example.com');
  assert.ok(r.citations[0].url === 'https://example.com');
  assert.equal(seenBody.text.maxCharacters, 20000);
  const bad = await exaGetContents({ urls: [] }, { env: { EXA_API_KEY: 'k' }, fetchImpl: async () => { throw new Error('no'); } });
  assert.equal(bad.ok, false);
  console.log('exa get contents: passed');
}

// --- find similar normalization
{
  let seenBody;
  const fetchImpl = async (_url, init) => {
    seenBody = JSON.parse(init.body);
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ results: [{ title: 'Similar', url: 'https://similar.example', summary: 'sum' }] }) };
  };
  const r = await exaFindSimilar({ url: 'https://source.example/a', numResults: 3 }, { env: { EXA_API_KEY: 'k' }, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].snippet, 'sum');
  assert.equal(r.citations.length, 1);
  assert.equal(seenBody.url, 'https://source.example/a');
  assert.equal(seenBody.excludeSourceDomain, true);
  console.log('exa find similar: passed');
}

// --- HTTP error and timeout handling
{
  const errFetch = async () => ({ ok: false, status: 401, headers: { get: () => 'application/json' }, json: async () => ({ error: { message: 'invalid api key sk-SECRET' } }) });
  const r = await exaSearch({ query: 'q' }, { env: { EXA_API_KEY: 'k' }, fetchImpl: errFetch });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'error');
  assert.ok(!String(r.error).includes('sk-SECRET'));
  const slow = (_u, init) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }, { once: true }); });
  const t = await exaSearch({ query: 'q' }, { env: { EXA_API_KEY: 'k' }, fetchImpl: slow, timeoutMs: 5 });
  assert.equal(t.ok, false);
  assert.equal(t.status, 'timeout');
  console.log('exa error/timeout: passed');
}

// --- activity labels
{
  assert.deepEqual(describe('exa_search_status', {}), ['Checking Exa search', 'Checked Exa search']);
  assert.deepEqual(describe('exa_search', { query: 'مرحبا بالعالم' })[1], 'Searched Exa');
  assert.ok(describe('exa_find_similar', { url: 'https://example.com/x' })[0].includes('example.com'));
  console.log('exa activity: passed');
}

// --- tools exposed with observe permissions and UI events
{
  const events = [];
  const { tools } = createTools({ allowActions: false, ui: (e) => events.push(e), ask: async () => false, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ['exa_search_status', 'exa_search', 'exa_get_contents', 'exa_find_similar']) {
    assert.ok(by[n], `${n} tool missing`);
    assert.equal(by[n].permission.level, 'observe');
    assert.equal(by[n].permission.requiresApproval, false);
  }
  const st = await by.exa_search_status.execute({});
  assert.equal(st.status, 'not_configured');
  assert.ok(events.some((e) => e.kind === 'browser' && e.action === 'exa_status'));
  console.log('exa tools: passed');
}

console.log('exa tests: all passed');
