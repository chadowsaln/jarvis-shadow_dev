// Exa (https://exa.ai/) web search/retrieval/research for Browser Intelligence and the agent's research tools.
// Optional provider: no API key required for JARVIS V2 to run. All network calls are explicit, injected/mockable for
// tests, and never expose the Exa key to the UI/logs.
//
// The key comes from the secure store (set in the panel) or EXA_API_KEY for headless runs. Everything here is
// documented on exa.ai/docs: /search, /contents, /findSimilar and /agent/runs (which replaced /research/v1).

const EXA_API_BASE = 'https://api.exa.ai';
export const EXA_PROVIDER = 'exa';

// The types /search currently documents. `keyword` is not one of them (it appears only in the cost breakdown), and
// sending it is a 400, so an unknown type is reported rather than passed through.
export const EXA_SEARCH_TYPES = ['auto', 'lite', 'deep-lite', 'deep', 'instant', 'fast', 'deep-reasoning'];
// Effort levels for a research run, with the price Exa publishes per run (USD) where it is fixed.
export const EXA_RESEARCH_EFFORT = { minimal: 0.012, low: 0.025, medium: 0.1, high: 0.5, xhigh: 1 };
const LEGACY_TYPES = new Set(['instant', 'fast', 'deep-reasoning']);

// Saved in the secure store by the panel; a string here never leaves this process.
let savedKey = null;
let enabled = true;
/** The Connections page switch. Off means every tool reports not_configured and nothing is sent. */
export function setExaEnabled(on) {
  enabled = on !== false;
}
/** Point the provider at a key from the secure store (null clears it and falls back to the environment). */
export function setExaKey(key) {
  const k = typeof key === 'string' ? key.trim() : '';
  savedKey = k || null;
}
/** Where the key in use came from: 'saved' (this app's secure store), 'env' or null. Never the key itself. */
export function exaKeySource({ env } = {}) {
  if (savedKey) return 'saved';
  return keyFromEnv(env ?? process.env) ? 'env' : null;
}

function keyFromEnv(env = process.env) {
  const k = env?.EXA_API_KEY;
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}
function keyOf(env) {
  if (!enabled) return null;
  return savedKey || keyFromEnv(env ?? process.env);
}

export function exaStatus({ env } = {}) {
  const source = exaKeySource({ env });
  const configured = !!source && enabled;
  return {
    provider: EXA_PROVIDER,
    configured,
    enabled,
    source,
    status: configured ? 'configured' : 'not_configured',
    note: !enabled
      ? 'Exa is turned off on the Connections page. Other search providers remain available.'
      : configured
      ? source === 'saved'
        ? 'Exa API key is saved on this computer.'
        : 'Exa API key is configured in the environment.'
      : 'Exa is not configured (no saved key and no EXA_API_KEY). Other search providers remain available.',
  };
}

function stripKey(v) {
  let s = String(v ?? '');
  s = s.replace(/([?&]?(?:api[_-]?key|token|key|authorization|x-api-key)=)[^&\s]+/ig, '$1[redacted]');
  s = s.replace(/\b(sk-[A-Za-z0-9_-]{6,}|exa-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._\-+/=]{8,})\b/gi, '[redacted]');
  s = s.replace(/([\"']?(?:api[_-]?key|apiKey|token|authorization|x-api-key)[\"']?\s*[:=]\s*[\"'])[^\"']+([\"'])/ig, '$1[redacted]$2');
  if (savedKey && s.includes(savedKey)) s = s.split(savedKey).join('[redacted]');
  return s;
}

function safeError(err, fallback = 'Exa request failed') {
  const msg = stripKey(err?.message || err || fallback);
  // never echo auth headers/values; keep it short and user-safe
  return msg.length > 300 ? msg.slice(0, 299) + '…' : msg || fallback;
}

function clampInt(n, min, max, dflt) {
  const v = Number(n);
  if (!Number.isFinite(v)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function normalizeResult(r = {}) {
  const url = typeof r.url === 'string' ? r.url : (typeof r.id === 'string' && /^https?:/i.test(r.id) ? r.id : '');
  const title = typeof r.title === 'string' ? r.title : '';
  const text = typeof r.text === 'string' ? r.text : (typeof r.summary === 'string' ? r.summary : '');
  const highlights = Array.isArray(r.highlights) ? r.highlights.filter((x) => typeof x === 'string').map((x) => x.slice(0, 500)) : [];
  const snippetSource = highlights[0] || text || '';
  const snippet = String(snippetSource).replace(/\s+/g, ' ').trim().slice(0, 500);
  const content = String(text || highlights.join('\n')).slice(0, 20000);
  const author = typeof r.author === 'string' ? r.author : undefined;
  const published = typeof r.publishedDate === 'string' ? r.publishedDate : (typeof r.published_date === 'string' ? r.published_date : undefined);
  const score = Number.isFinite(r.score) ? r.score : undefined;
  const summary = typeof r.summary === 'string' ? r.summary.slice(0, 4000) : undefined;
  const out = {
    title,
    url,
    snippet,
    content,
    source: EXA_PROVIDER,
    provider: EXA_PROVIDER,
    highlights,
    citation: url ? { title, url, source: EXA_PROVIDER } : null,
  };
  if (author) out.author = author;
  if (published) out.publishedDate = published;
  if (score != null) out.score = score;
  if (summary) out.summary = summary;
  if (typeof r.id === 'string') out.id = r.id;
  // /contents names a per-document outcome ('success', 'not_found', …): keep it rather than pretending it worked.
  if (typeof r.status === 'string') out.status = r.status;
  const err = r.error ?? r.errorMessage;
  if (err) out.error = safeError(typeof err === 'string' ? err : err?.message || err, 'page could not be read');
  return out;
}

function sanitizeQuery(q) {
  const s = String(q ?? '').trim();
  return s.length > 2000 ? s.slice(0, 2000) : s;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  const t = setTimeout(resolve, ms);
  const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
  try { signal?.addEventListener('abort', onAbort, { once: true }); } catch { /* no signal support */ }
});

// How long the far end asked us to wait (seconds or an HTTP date), capped so a reply is never held for long.
function retryAfterMs(headers) {
  const raw = String(headers?.get?.('retry-after') ?? '').trim();
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(5000, secs * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.min(5000, at - Date.now())) : null;
}

async function exaRequest(path, body, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000, signal, method = 'POST', retries = 2 } = {}) {
  const apiKey = keyOf(env);
  if (!apiKey) return { ok: false, status: 'not_configured', provider: EXA_PROVIDER, error: 'Exa is not configured (no saved key and no EXA_API_KEY).', note: 'Add a key on the Connections page, or set EXA_API_KEY. Other search providers remain available.' };
  if (typeof fetchImpl !== 'function') return { ok: false, status: 'error', provider: EXA_PROVIDER, error: 'fetch unavailable' };

  for (let attempt = 0; ; attempt++) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timedOut = false;
    const timer = ctrl ? setTimeout(() => { timedOut = true; try { ctrl.abort(new Error('timeout')); } catch { try { ctrl.abort(); } catch {} } }, Math.max(1, Number(timeoutMs) || 15000)) : null;
    const onAbort = () => { if (timedOut) return; try { ctrl?.abort(signal?.reason); } catch { try { ctrl?.abort(); } catch {} } };
    if (ctrl && signal) {
      if (signal.aborted) onAbort(); else try { signal.addEventListener('abort', onAbort, { once: true }); } catch {}
    }
    let res = null, data = null, failure = null;
    try {
      res = await fetchImpl(`${EXA_API_BASE}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
          'x-api-key': apiKey,
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
      const ct = String(res?.headers?.get?.('content-type') || '');
      if (ct.includes('application/json')) data = await res.json().catch(() => null);
      else {
        const t = await res.text().catch(() => '');
        try { data = JSON.parse(t); } catch { data = t ? { error: t } : null; }
      }
    } catch (e) {
      const aborted = ctrl?.signal?.aborted || e?.name === 'AbortError';
      const reason = String(ctrl?.signal?.reason?.message || ctrl?.signal?.reason || signal?.reason?.message || signal?.reason || e?.message || '');
      const timeout = timedOut || (aborted && /timeout/i.test(reason));
      failure = { ok: false, status: timeout ? 'timeout' : 'error', provider: EXA_PROVIDER, error: timeout ? 'Exa request timed out.' : safeError(e) };
    } finally {
      if (timer) clearTimeout(timer);
      if (ctrl && signal) { try { signal.removeEventListener('abort', onAbort); } catch {} }
    }
    if (failure) return failure;

    const code = Number(res?.status) || 0;
    // Rate limited or a transient server error: wait what Exa asked for, then try again (twice at most).
    const transient = code === 429 || code === 500 || code === 502 || code === 503 || code === 504;
    if (!res?.ok && transient && attempt < retries) {
      await sleep(retryAfterMs(res?.headers) ?? (attempt === 0 ? 500 : 1500), signal);
      continue;
    }
    if (!res?.ok) {
      const msg = safeError(data?.error?.message || data?.error || data?.message || `HTTP ${code || 'error'}`);
      return {
        ok: false, status: 'error', provider: EXA_PROVIDER, httpStatus: code || null, error: msg,
        // Said plainly, because the fix is in the settings, not in a retry.
        ...(code === 401 || code === 403 ? { hint: 'The Exa key was refused. Check it on the Connections page.' } : {}),
        ...(code === 402 ? { hint: 'Exa says the account is out of credit.' } : {}),
        ...(code === 429 ? { hint: 'Exa is rate limiting requests. Try again in a moment.' } : {}),
      };
    }
    return { ok: true, status: 'ok', provider: EXA_PROVIDER, data: data && typeof data === 'object' ? data : {} };
  }
}

export async function exaSearch({ query, numResults, type, category, includeDomains, excludeDomains, startPublishedDate, endPublishedDate, contents, timeoutMs } = {}, opts = {}) {
  const q = sanitizeQuery(query);
  if (!q) return { ok: false, status: 'error', provider: EXA_PROVIDER, error: 'query is required' };
  const wanted = typeof type === 'string' && type.trim() ? type.trim() : 'auto';
  if (!EXA_SEARCH_TYPES.includes(wanted)) {
    return { ok: false, status: 'error', provider: EXA_PROVIDER, error: `Unsupported search type "${wanted}".`, hint: `Use one of: ${EXA_SEARCH_TYPES.join(', ')}.` };
  }
  const n = clampInt(numResults, 1, 20, 5);
  const body = {
    query: q,
    numResults: n,
    type: wanted,
  };
  if (typeof category === 'string' && category) body.category = category;
  if (Array.isArray(includeDomains) && includeDomains.length) body.includeDomains = includeDomains.slice(0, 20).map(String);
  if (Array.isArray(excludeDomains) && excludeDomains.length) body.excludeDomains = excludeDomains.slice(0, 20).map(String);
  if (typeof startPublishedDate === 'string' && startPublishedDate) body.startPublishedDate = startPublishedDate;
  if (typeof endPublishedDate === 'string' && endPublishedDate) body.endPublishedDate = endPublishedDate;
  // Ask for snippets/highlights; keep text bounded
  const wantText = contents !== false;
  body.contents = wantText ? { text: { maxCharacters: 2000 }, highlights: { numSentences: 2, highlightsPerUrl: 2 } } : false;
  const r = await exaRequest('/search', body, { ...opts, timeoutMs: timeoutMs ?? opts.timeoutMs ?? 15000 });
  if (!r.ok) return r;
  const results = Array.isArray(r.data?.results) ? r.data.results.slice(0, n).map(normalizeResult) : [];
  const citations = results.map((x) => x.citation).filter(Boolean);
  return {
    ok: true, status: 'ok', provider: EXA_PROVIDER, query: q, type: wanted, results, citations, count: results.length,
    ...(LEGACY_TYPES.has(wanted) ? { note: `"${wanted}" is a legacy search type; "auto" or "deep" is recommended.` } : {}),
    ...(r.data?.costDollars ? { costDollars: r.data.costDollars } : {}),
  };
}

export async function exaGetContents({ urls, ids, maxCharacters, summary, query, subpages, maxAgeHours, livecrawlTimeout, timeoutMs } = {}, opts = {}) {
  const list = (Array.isArray(urls) ? urls : []).map((u) => String(u || '').trim()).filter(Boolean).slice(0, 20);
  const idList = (Array.isArray(ids) ? ids : []).map((u) => String(u || '').trim()).filter(Boolean).slice(0, 20);
  if (!list.length && !idList.length) return { ok: false, status: 'error', provider: EXA_PROVIDER, error: 'urls (or ids) is required' };
  if (list.length && idList.length) return { ok: false, status: 'error', provider: EXA_PROVIDER, error: 'Pass urls or ids, not both.' };
  const maxChars = clampInt(maxCharacters, 200, 50000, 4000);
  const body = { text: { maxCharacters: maxChars }, highlights: { numSentences: 3, highlightsPerUrl: 3 } };
  if (idList.length) body.ids = idList; else body.urls = list;
  // A focused summary is what "generate a summary" means here: Exa writes it from the page, we never do.
  if (summary === true || typeof summary === 'string') body.summary = { query: typeof summary === 'string' && summary.trim() ? summary.trim().slice(0, 500) : sanitizeQuery(query) || 'Summarise this page.' };
  else if (summary && typeof summary === 'object') body.summary = summary;
  if (subpages != null) body.subpages = clampInt(subpages, 0, 100, 0);
  if (maxAgeHours != null) body.maxAgeHours = clampInt(maxAgeHours, -1, 720, 0);
  if (livecrawlTimeout != null) body.livecrawlTimeout = clampInt(livecrawlTimeout, 1000, 90000, 10000);
  const r = await exaRequest('/contents', body, { ...opts, timeoutMs: timeoutMs ?? opts.timeoutMs ?? 20000 });
  if (!r.ok) return r;
  const results = Array.isArray(r.data?.results) ? r.data.results.map(normalizeResult) : [];
  const statuses = Array.isArray(r.data?.statuses) ? r.data.statuses.map((s) => ({ id: s?.id ?? null, status: s?.status ?? null, ...(s?.error ? { error: safeError(s.error) } : {}) })) : [];
  const failed = [...results.filter((x) => x.error || (x.status && x.status !== 'success')).map((x) => x.url), ...statuses.filter((s) => s.status && s.status !== 'success' && !s.id?.startsWith?.('http')).map((s) => s.id)].filter(Boolean);
  const citations = results.map((x) => x.citation).filter(Boolean);
  return {
    ok: true, status: 'ok', provider: EXA_PROVIDER, results, citations, count: results.length,
    ...(statuses.length ? { statuses } : {}),
    ...(failed.length ? { failed: [...new Set(failed)].slice(0, 20) } : {}),
  };
}

export async function exaFindSimilar({ url, numResults, excludeSourceDomain, timeoutMs } = {}, opts = {}) {
  const u = String(url || '').trim();
  if (!u) return { ok: false, status: 'error', provider: EXA_PROVIDER, error: 'url is required' };
  const n = clampInt(numResults, 1, 20, 5);
  const body = { url: u, numResults: n, excludeSourceDomain: excludeSourceDomain !== false, contents: { text: { maxCharacters: 1200 }, highlights: { numSentences: 2, highlightsPerUrl: 2 } } };
  const r = await exaRequest('/findSimilar', body, { ...opts, timeoutMs: timeoutMs ?? opts.timeoutMs ?? 15000 });
  if (!r.ok) return r;
  const results = Array.isArray(r.data?.results) ? r.data.results.slice(0, n).map(normalizeResult) : [];
  const citations = results.map((x) => x.citation).filter(Boolean);
  return { ok: true, status: 'ok', provider: EXA_PROVIDER, url: u, results, citations, count: results.length };
}

// What a research run found, split the way the answer must be: pages Exa actually read (retrieved) and Exa's own
// written answer (generated). Anything schema-shaped comes back in `structured`.
function researchSources(run) {
  const out = [];
  const add = (c, field) => {
    const url = typeof c?.url === 'string' ? c.url : null;
    if (!url) return;
    out.push({ title: typeof c.title === 'string' ? c.title : '', url, field: field ?? null, confidence: Number.isFinite(c.confidence) ? c.confidence : null });
  };
  const grounding = run?.output?.grounding;
  if (Array.isArray(grounding)) {
    for (const g of grounding) {
      const field = typeof g?.field === 'string' ? g.field : null;
      for (const c of Array.isArray(g?.citations) ? g.citations : []) add(c, field);
    }
  }
  // Older/alternate shape: a flat citations array.
  for (const c of Array.isArray(run?.output?.citations) ? run.output.citations : []) add(c, null);
  const seen = new Set();
  return out.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
}

/**
 * A multi-source research run through Exa's Agent API (POST /agent/runs, then GET /agent/runs/{id}).
 *
 * This costs real money per run (fixed effort levels are priced in EXA_RESEARCH_EFFORT; `auto` is metered), so the
 * tool that calls it asks first. `maxDurationMs` and the abort signal are hard caps: a run that outlives them is
 * reported as unfinished, never left polling forever.
 */
export async function exaResearch({ query, effort = 'low', outputSchema = null, maxDurationMs = 180000, pollMs = 2000, budget = null } = {}, opts = {}) {
  const q = sanitizeQuery(query);
  if (!q) return { ok: false, status: 'error', provider: EXA_PROVIDER, error: 'query is required' };
  const lvl = typeof effort === 'string' && effort.trim() ? effort.trim() : 'low';
  if (!(lvl in EXA_RESEARCH_EFFORT) && lvl !== 'auto' && lvl !== 'ultra') {
    return { ok: false, status: 'error', provider: EXA_PROVIDER, error: `Unsupported effort "${lvl}".`, hint: `Use one of: ${[...Object.keys(EXA_RESEARCH_EFFORT), 'auto', 'ultra'].join(', ')}.` };
  }
  const body = { query: q, effort: lvl };
  if (outputSchema && typeof outputSchema === 'object') body.outputSchema = outputSchema;
  if (budget && typeof budget === 'object') body.budget = budget;
  const started = Date.now();
  const cap = Math.max(1000, Number(maxDurationMs) || 180000);
  const created = await exaRequest('/agent/runs', body, { ...opts, timeoutMs: opts.timeoutMs ?? 30000 });
  if (!created.ok) return created;
  const id = typeof created.data?.id === 'string' ? created.data.id : null;
  if (!id) return { ok: false, status: 'error', provider: EXA_PROVIDER, error: 'Exa did not return a run id.' };

  let run = created.data;
  try {
    while (run?.status === 'queued' || run?.status === 'running' || (!run?.status && !run?.output)) {
      if (Date.now() - started > cap) {
        return {
          ok: false, status: 'timeout', provider: EXA_PROVIDER, runId: id, runStatus: run?.status ?? null,
          error: `The research run is still ${run?.status ?? 'working'} after ${Math.round((Date.now() - started) / 1000)} s.`,
          hint: `It may still finish on Exa's side; ask again with run id ${id} or a higher effort limit.`,
        };
      }
      await sleep(Math.max(250, Number(pollMs) || 2000), opts.signal);
      const got = await exaRequest(`/agent/runs/${encodeURIComponent(id)}`, null, { ...opts, method: 'GET', timeoutMs: opts.timeoutMs ?? 30000 });
      if (!got.ok) return got;
      run = got.data;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, status: 'cancelled', provider: EXA_PROVIDER, runId: id, error: 'The research run was stopped.' };
    return { ok: false, status: 'error', provider: EXA_PROVIDER, runId: id, error: safeError(e) };
  }

  if (run?.status && run.status !== 'completed') {
    return { ok: false, status: run.status === 'cancelled' ? 'cancelled' : 'error', provider: EXA_PROVIDER, runId: id, runStatus: run.status, error: safeError(run?.error?.message || run?.error || `Exa's research run ${run.status}.`) };
  }
  const answer = typeof run?.output?.text === 'string' ? run.output.text.slice(0, 20000) : '';
  const structured = run?.output?.structured && typeof run.output.structured === 'object' ? run.output.structured : null;
  const sources = researchSources(run);
  return {
    ok: true, status: 'ok', provider: EXA_PROVIDER, runId: id, query: q, effort: lvl,
    // Retrieved vs generated, kept apart on purpose: `sources` are pages Exa read, `answer` is Exa's own writing.
    answer, generated: true, sources, citations: sources.map((s) => ({ title: s.title, url: s.url, source: EXA_PROVIDER })),
    ...(structured ? { structured } : {}),
    ...(run?.costDollars ? { costDollars: run.costDollars } : {}),
    ...(run?.usage ? { usage: run.usage } : {}),
    ms: Date.now() - started,
  };
}
