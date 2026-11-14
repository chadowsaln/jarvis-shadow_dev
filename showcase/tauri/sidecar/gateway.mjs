// Side calls through the Respan Gateway (gateway/ beside this file): the fold and the memory pass in
// brain.mjs each ask one short question and get a JSON answer back. The gateway speaks OpenAI's chat
// format and routes the model to whichever provider its config or environment holds, so those two
// calls can follow the account with credit without the app knowing a second sign-in.
//
// Off unless ROAMIES_GATEWAY_URL is set (or ROAMIES_GATEWAY=1 for the port `npm run gateway` uses):
// the side calls keep using the app's own sign-in otherwise, and also when the gateway fails.

// The loopback port `npm run gateway` serves on; a client with a key may point ROAMIES_GATEWAY_URL elsewhere.
export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8788';
// A fold or a memory pass can take a while; the same budget brain.mjs gives its own side calls.
export const GATEWAY_TIMEOUT_MS = 120_000;

const base = (s) => String(s ?? '').trim().replace(/\/+$/, '');
const truthy = (s) => ['1', 'true', 'yes', 'on'].includes(String(s ?? '').toLowerCase().trim());

/**
 * The gateway for this run, read from the environment. null when it is off.
 * → { url, key, model, timeout }: `key` is a client key when the gateway's config sets client_keys,
 * `model` the route or model to ask for (null keeps the side calls' own summary model), both optional.
 * Never throws: anything unset or unreadable just leaves that part out.
 */
export function gatewayRoute(env = process.env) {
  const given = base(env?.ROAMIES_GATEWAY_URL);
  const url = given || (truthy(env?.ROAMIES_GATEWAY) ? DEFAULT_GATEWAY_URL : '');
  if (!url) return null;
  const timeout = Number(env?.ROAMIES_GATEWAY_TIMEOUT_MS);
  return {
    url,
    key: String(env?.ROAMIES_GATEWAY_KEY ?? '').trim() || null,
    model: String(env?.ROAMIES_GATEWAY_MODEL ?? '').trim() || null,
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : GATEWAY_TIMEOUT_MS,
  };
}

/** A chat reply's text: OpenAI's message.content is a string, or a list of parts. '' when there is none. */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : (p?.type === 'text' ? p.text ?? '' : ''))).join('');
  return '';
}

/** What the gateway said went wrong, in one line: its error message when it sent one. */
export function errorLine(body) {
  const text = String(body ?? '').trim();
  try {
    const m = JSON.parse(text);
    const msg = m?.error?.message ?? m?.error ?? m?.message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim().replace(/\s+/g, ' ').slice(0, 200);
  } catch {}
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * One tool-less chat turn through the gateway's OpenAI-compatible endpoint.
 * `{ url, key, model, system, text, signal, timeout }` → the reply's text (non-empty, or it throws).
 * Failures are `gateway_<status>`, `gateway_timeout`, `gateway_unreachable`, `gateway_bad_reply` or
 * `gateway_empty_reply`, so a caller can say what went wrong without the response body in a log.
 */
export async function gatewayComplete({
  url, key = null, model, system = null, text, signal = null, timeout = GATEWAY_TIMEOUT_MS, fetchImpl = fetch,
}) {
  const at = base(url);
  if (!at) throw new Error('gateway_url_missing');
  if (!model) throw new Error('gateway_model_missing');
  const messages = [];
  if (system) messages.push({ role: 'system', content: String(system) });
  messages.push({ role: 'user', content: String(text ?? '') });

  let res;
  try {
    res = await fetchImpl(`${at}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages, stream: false }),
      // The gateway's budget, and the caller's own stop (Esc, or brain.mjs's timeout) when it has one.
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout),
    });
  } catch (e) {
    if (signal?.aborted) throw e; // the caller stopped it: its own reason, not the gateway's
    if (e?.name === 'TimeoutError') throw new Error('gateway_timeout');
    throw new Error(`gateway_unreachable: ${String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 120)}`);
  }

  const body = await res.text();
  if (!res.ok) throw new Error(`gateway_${res.status}: ${errorLine(body)}`);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('gateway_bad_reply');
  }
  const out = contentText(data?.choices?.[0]?.message?.content);
  if (!out.trim()) throw new Error('gateway_empty_reply');
  return out;
}
