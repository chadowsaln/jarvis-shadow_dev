// Exa (https://exa.ai/) web search/retrieval integration for Browser Intelligence.
// Optional provider: no API key required for JARVIS V2 to run. All network calls are explicit,
// injected/mockable for tests, and never expose EXA_API_KEY to the UI/logs.

const EXA_API_BASE = 'https://api.exa.ai';
export const EXA_PROVIDER = 'exa';

function keyFromEnv(env = process.env) {
  const k = env?.EXA_API_KEY;
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}

export function exaStatus({ env = process.env } = {}) {
  const configured = !!keyFromEnv(env);
  return {
    provider: EXA_PROVIDER,
    configured,
    status: configured ? 'configured' : 'not_configured',
    note: configured
      ? 'Exa API key is configured (server-side).'
      : 'Exa is not configured (EXA_API_KEY missing). Other search providers remain available.',
  };
}

function stripKey(v) {
  let s = String(v ?? '');
  s = s.replace(/([?&]?(?:api[_-]?key|token|key|authorization|x-api-key)=)[^&\s]+/ig, '$1[redacted]');
  s = s.replace(/\b(sk-[A-Za-z0-9_-]{6,}|exa-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._\-+/=]{8,})\b/gi, '[redacted]');
  s = s.replace(/([\"']?(?:api[_-]?key|apiKey|token|authorization|x-api-key)[\"']?\s*[:=]\s*[\"'])[^\"']+([\"'])/ig, '$1[redacted]$2');
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
  return out;
}

function sanitizeQuery(q) {
  const s = String(q ?? '').trim();
  return s.length > 2000 ? s.slice(0, 2000) : s;
}

async function exaRequest(path, body, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000, signal } = {}) {
  const apiKey = keyFromEnv(env);
  if (!apiKey) return { ok: false, status: 'not_configured', provider: EXA_PROVIDER, error: 'Exa is not configured (EXA_API_KEY missing).', note: 'Set EXA_API_KEY in a secure environment/setting to enable Exa. Other search providers remain available.' };
  if (typeof fetchImpl !== 'function') return { ok: false, status: 'error', provider: EXA_PROVIDER, error: 'fetch unavailable' };
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timedOut = false;
  const timer = ctrl ? setTimeout(() => { timedOut = true; try { ctrl.abort(new Error('timeout')); } catch { try { ctrl.abort(); } catch {} } }, Math.max(1, Number(timeoutMs) || 15000)) : null;
  const onAbort = () => { if (timedOut) return; try { ctrl?.abort(signal?.reason); } catch { try { ctrl?.abort(); } catch {} } };
  if (ctrl && signal) {
    if (signal.aborted) onAbort(); else try { signal.addEventListener('abort', onAbort, { once: true }); } catch {}
  }
  try {
    const res = await fetchImpl(`${EXA_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body || {}),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    const ct = String(res?.headers?.get?.('content-type') || '');
    let data = null;
    if (ct.includes('application/json')) data = await res.json().catch(() => null);
    else {
      const t = await res.text().catch(() => '');
      try { data = JSON.parse(t); } catch { data = t ? { error: t } : null; }
    }
    if (!res?.ok) {
      const msg = safeError(data?.error?.message || data?.error || data?.message || `HTTP ${res?.status || 'error'}`);
      return { ok: false, status: 'error', provider: EXA_PROVIDER, httpStatus: res?.status ?? null, error: msg };
    }
    return { ok: true, status: 'ok', provider: EXA_PROVIDER, data: data && typeof data === 'object' ? data : {} };
  } catch (e) {
    const aborted = ctrl?.signal?.aborted || e?.name === 'AbortError';
    const reason = String(ctrl?.signal?.reason?.message || ctrl?.signal?.reason || signal?.reason?.message || signal?.reason || e?.message || '');
    const timeout = timedOut || (aborted && /timeout/i.test(reason));
    return { ok: false, status: timeout ? 'timeout' : 'error', provider: EXA_PROVIDER, error: timeout ? 'Exa request timed out.' : safeError(e) };
  } finally {
    if (timer) clearTimeout(timer);
    if (ctrl && signal) { try { signal.removeEventListener('abort', onAbort); } catch {} }
  }
}

export async function exaSearch({ query, numResults, type, category, includeDomains, excludeDomains, startPublishedDate, endPublishedDate, contents, timeoutMs } = {}, opts = {}) {
  const q = sanitizeQuery(query);
  if (!q) return { ok: false, status: 'error', provider: EXA_PROVIDER, error: 'query is required' };
  const n = clampInt(numResults, 1, 10, 5);
  const body = {
    query: q,
    numResults: n,
    type: typeof type === 'string' ? type : 'auto',
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
  return { ok: true, status: 'ok', provider: EXA_PROVIDER, query: q, results, citations, count: results.length };
}

export async function exaGetContents({ urls, maxCharacters, timeoutMs } = {}, opts = {}) {
  const list = (Array.isArray(urls) ? urls : []).map((u) => String(u || '').trim()).filter(Boolean).slice(0, 10);
  if (!list.length) return { ok: false, status: 'error', provider: EXA_PROVIDER, error: 'urls is required' };
  const maxChars = clampInt(maxCharacters, 200, 20000, 4000);
  const body = { urls: list, text: { maxCharacters: maxChars }, highlights: { numSentences: 3, highlightsPerUrl: 3 } };
  const r = await exaRequest('/contents', body, { ...opts, timeoutMs: timeoutMs ?? opts.timeoutMs ?? 20000 });
  if (!r.ok) return r;
  const results = Array.isArray(r.data?.results) ? r.data.results.map(normalizeResult) : [];
  const citations = results.map((x) => x.citation).filter(Boolean);
  return { ok: true, status: 'ok', provider: EXA_PROVIDER, results, citations, count: results.length };
}

export async function exaFindSimilar({ url, numResults, excludeSourceDomain, timeoutMs } = {}, opts = {}) {
  const u = String(url || '').trim();
  if (!u) return { ok: false, status: 'error', provider: EXA_PROVIDER, error: 'url is required' };
  const n = clampInt(numResults, 1, 10, 5);
  const body = { url: u, numResults: n, excludeSourceDomain: excludeSourceDomain !== false, contents: { text: { maxCharacters: 1200 }, highlights: { numSentences: 2, highlightsPerUrl: 2 } } };
  const r = await exaRequest('/findSimilar', body, { ...opts, timeoutMs: timeoutMs ?? opts.timeoutMs ?? 15000 });
  if (!r.ok) return r;
  const results = Array.isArray(r.data?.results) ? r.data.results.slice(0, n).map(normalizeResult) : [];
  const citations = results.map((x) => x.citation).filter(Boolean);
  return { ok: true, status: 'ok', provider: EXA_PROVIDER, url: u, results, citations, count: results.length };
}
