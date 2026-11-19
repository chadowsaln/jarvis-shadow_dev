// Exa integration tests (Batch 11): mock-only, no network, no API key required.
// Run: node showcase/tauri/sidecar/test/exa.test.mjs
import assert from 'node:assert/strict';
import { exaStatus, exaSearch, exaGetContents, exaFindSimilar, exaResearch, setExaEnabled, setExaKey } from '../exa.mjs';
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
  assert.equal(seenBody.text.maxCharacters, 50000, 'contents text is capped at Exa\'s documented 50000');
  const bad = await exaGetContents({ urls: [] }, { env: { EXA_API_KEY: 'k' }, fetchImpl: async () => { throw new Error('no'); } });
  assert.equal(bad.ok, false);
  console.log('exa get contents: passed');
}

// --- documented search types only, legacy ones labelled, 429 retried after the delay Exa asks for
{
  const bad = await exaSearch({ query: 'q', type: 'keyword' }, { env: { EXA_API_KEY: 'k' }, fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unsupported search type/);
  assert.match(bad.hint, /auto/);
  let seenBody;
  const fetchImpl = async (_url, init) => {
    seenBody = JSON.parse(init.body);
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ results: [] }) };
  };
  const legacy = await exaSearch({ query: 'q', type: 'fast' }, { env: { EXA_API_KEY: 'k' }, fetchImpl });
  assert.equal(legacy.ok, true);
  assert.match(legacy.note, /legacy/);
  assert.equal(seenBody.type, 'fast');

  let tries = 0;
  const limited = await exaSearch({ query: 'q' }, {
    env: { EXA_API_KEY: 'k' },
    fetchImpl: async () => {
      tries++;
      if (tries === 1) return { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '0' : 'application/json') }, json: async () => ({ error: { message: 'slow down' } }) };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ results: [{ url: 'https://ok.example' }] }) };
    },
  });
  assert.equal(tries, 2, 'a 429 is retried once after the delay');
  assert.equal(limited.ok, true);
  assert.equal(limited.results[0].url, 'https://ok.example');

  const exhausted = await exaSearch({ query: 'q' }, {
    env: { EXA_API_KEY: 'k' },
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '0' : 'application/json') }, json: async () => ({ error: { message: 'slow down' } }) }),
  });
  assert.equal(exhausted.ok, false);
  assert.match(exhausted.hint, /rate limiting/);
  console.log('exa search types and rate limits: passed');
}

// --- contents: summary, subpages, ids, and per-page outcomes kept honest
{
  let seenBody;
  const fetchImpl = async (_url, init) => {
    seenBody = JSON.parse(init.body);
    return {
      ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({
        results: [
          { id: 'https://ok.example', title: 'Fine', url: 'https://ok.example', text: 'hello', status: 'success' },
          { id: 'https://gone.example', status: 'not_found', error: 'CRAWL_NOT_FOUND' },
        ],
        statuses: [{ id: 'https://ok.example', status: 'success' }, { id: 'https://gone.example', status: 'not_found' }],
      }),
    };
  };
  const r = await exaGetContents({ urls: ['https://ok.example', 'https://gone.example'], summary: 'prices', subpages: 2, maxAgeHours: 0 }, { env: { EXA_API_KEY: 'k' }, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(seenBody.summary.query, 'prices');
  assert.equal(seenBody.subpages, 2);
  assert.equal(seenBody.maxAgeHours, 0);
  assert.equal(r.results[0].status, 'success');
  assert.equal(r.results[1].status, 'not_found');
  assert.match(r.results[1].error, /CRAWL_NOT_FOUND/);
  assert.deepEqual(r.failed, ['https://gone.example'], 'a page that could not be read is named, not silently empty');
  assert.equal(r.statuses.length, 2);

  // ids and urls are mutually exclusive, as Exa documents.
  const both = await exaGetContents({ urls: ['https://a.example'], ids: ['01abc'] }, { env: { EXA_API_KEY: 'k' }, fetchImpl });
  assert.equal(both.ok, false);
  assert.match(both.error, /not both/);
  const byId = await exaGetContents({ ids: ['01abc'] }, { fetchImpl, env: { EXA_API_KEY: 'k' } });
  assert.equal(byId.ok, true);
  assert.deepEqual(seenBody.ids, ['01abc']);
  assert.equal(seenBody.urls, undefined);
  console.log('exa contents options: passed');
}

// --- research: create, poll, retrieved sources kept apart from the generated answer
{
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'POST', body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/agent/runs')) {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ id: 'agent_run_1', status: 'queued' }) };
    }
    polls++;
    const done = polls >= 2;
    return {
      ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => (done
        ? {
          id: 'agent_run_1', status: 'completed', costDollars: { total: 0.025 },
          output: {
            text: 'Robotics moved toward general-purpose humanoids.',
            structured: { themes: ['humanoids'] },
            grounding: [{ field: 'text', confidence: 0.8, citations: [{ title: 'Robotics weekly', url: 'https://news.example/robots' }, { title: 'Lab paper', url: 'https://paper.example/humanoid' }] }],
          },
        }
        : { id: 'agent_run_1', status: 'running' }),
    };
  };
  const r = await exaResearch({ query: 'latest robotics', effort: 'low' }, { env: { EXA_API_KEY: 'k' }, fetchImpl, pollMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.runId, 'agent_run_1');
  assert.equal(r.generated, true, 'the answer is Exa\'s writing, and says so');
  assert.match(r.answer, /humanoids/);
  assert.deepEqual(r.structured, { themes: ['humanoids'] });
  assert.deepEqual(r.sources.map((s) => s.url), ['https://news.example/robots', 'https://paper.example/humanoid'], 'retrieved pages are listed separately');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.effort, 'low');
  assert.ok(calls.slice(1).every((c) => c.method === 'GET' && c.url.includes('/agent/runs/agent_run_1')));

  const failed = await exaResearch({ query: 'q' }, {
    env: { EXA_API_KEY: 'k' }, pollMs: 1,
    fetchImpl: async (url) => (String(url).endsWith('/agent/runs')
      ? { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ id: 'agent_run_2', status: 'queued' }) }
      : { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ id: 'agent_run_2', status: 'failed', error: 'internal' }) }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.runStatus, 'failed');
  assert.match(failed.error, /internal/);

  // A run that outlives its cap is reported unfinished, with its id, instead of polling forever.
  const capped = await exaResearch({ query: 'q', maxDurationMs: 1000 }, {
    env: { EXA_API_KEY: 'k' }, pollMs: 1200,
    fetchImpl: async (url) => (String(url).endsWith('/agent/runs')
      ? { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ id: 'agent_run_3', status: 'queued' }) }
      : { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ id: 'agent_run_3', status: 'running' }) }),
  });
  assert.equal(capped.ok, false);
  assert.equal(capped.status, 'timeout');
  assert.equal(capped.runId, 'agent_run_3');

  const unsupported = await exaResearch({ query: 'q', effort: 'turbo' }, { env: { EXA_API_KEY: 'k' }, fetchImpl });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /Unsupported effort/);
  console.log('exa research: passed');
}

// --- the key can come from the secure store, and the provider can be switched off
{
  setExaKey('exa-saved-secret');
  const saved = exaStatus({});
  assert.equal(saved.configured, true);
  assert.equal(saved.source, 'saved');
  assert.equal(JSON.stringify(saved).includes('exa-saved-secret'), false);
  const r = await exaSearch({ query: 'q' }, { env: {}, fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => 'application/json' }, json: async () => ({ error: { message: 'denied' } }) }) });
  assert.equal(r.ok, false);
  assert.match(r.hint, /Connections page/);
  setExaEnabled(false);
  const off = exaStatus({});
  assert.equal(off.configured, false);
  assert.equal(off.enabled, false);
  assert.match(off.note, /turned off/);
  const blocked = await exaSearch({ query: 'q' }, { fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal(blocked.status, 'not_configured');
  setExaEnabled(true);
  setExaKey(null);
  assert.equal(exaStatus({ env: {} }).source, null, 'clearing the saved key falls back to the environment');
  console.log('exa key source and switch: passed');
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
  // Research costs real money per run, so it asks first even at the trusted default.
  assert.ok(by.exa_research, 'exa_research tool missing');
  assert.equal(by.exa_research.permission.level, 'observe');
  assert.equal(by.exa_research.permission.requiresApproval, true);
  const st = await by.exa_search_status.execute({});
  assert.equal(st.status, 'not_configured');
  assert.ok(events.some((e) => e.kind === 'browser' && e.action === 'exa_status'));
  console.log('exa tools: passed');
}

console.log('exa tests: all passed');
