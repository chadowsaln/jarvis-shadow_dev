// Respan observability for JARVIS V2: one trace per request, spans for the LLM turn, tool calls and agent steps.
//
// Built on @respan/respan (the vendor's TypeScript SDK): it owns the OTLP exporter, batch queue and flush, so
// nothing here does its own HTTP. The SDK is imported only when the person has enabled Respan and saved a key -
// telemetry is never a requirement for JARVIS to start, answer or run a tool.
//
// Two things the SDK does that this module has to contain:
// - It prints a `[Respan Debug]` banner on initialize even with logLevel "error" and silenced initialization.
//   In this app stdout is the JSON protocol to the Tauri shell, so a stray line can corrupt IPC: console output is
//   muted around initialize() (see `withoutStdoutNoise`) and any explanation goes to `logger` instead.
// - Its automatic provider discovery monkey-patches model SDKs. JARVIS talks to providers through gg-agent, so
//   discovery is passed an empty list: spans come from this module, never from patched clients.
//
// Privacy: metadata by default (model, provider, latency, tokens, status, tool names). Payloads are opt-in and
// always pass `redactArgs` + `scrub` first; tool arguments/results stay local unless that is switched on separately.
import { context, trace as otelTrace } from '@opentelemetry/api';
import { redactArgs } from './safety.mjs';

const DEFAULT_BASE_URL = 'https://api.respan.ai/api';
const MAX_TEXT = 2000;
const MAX_RESULT = 400;
const MAX_ARGS = 600;

// What may look like a credential, wherever it appears in a string we were about to send.
const SECRET_LIKE = /\b(sk-[A-Za-z0-9_-]{6,}|rsp-[A-Za-z0-9_-]{6,}|exa-[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9]{6,}|Bearer\s+[A-Za-z0-9._\-+/=]{8,})\b/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** A string safe to put in a span: secrets and e-mail addresses removed, length capped. */
export function scrub(text, max = MAX_TEXT) {
  const s = String(text ?? '').replace(SECRET_LIKE, '[redacted]').replace(EMAIL, '[email]');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The settings Respan runs with. Everything optional: an unconfigured host simply has no telemetry. */
export const RESPAN_DEFAULTS = Object.freeze({
  enabled: false,
  environment: 'development', // 'development' | 'production', as a span attribute only
  baseURL: DEFAULT_BASE_URL,
  gateway: false,
  traceLlmRequests: true,
  traceToolCalls: true,
  traceAgentSteps: true,
  capturePayloads: true, // the LLM turn's own words (redacted, capped): needed for evaluation
  captureToolPayloads: false, // tool arguments/results can hold file contents and screen text
  sampleRate: 1,
});

let sdk = null;
let client = null;
let gatewayKey = null; // only for optional gateway routing; never read back out in status or logs
let reason = null;
let status = 'off'; // off | not_configured | ready | failed
let options = { ...RESPAN_DEFAULTS };
let initializing = null;
const stats = { traces: 0, spans: 0, errors: 0, skipped: 0, lastError: null };

/** Nothing sensitive: no key, ever. */
export function respanStatus() {
  return {
    provider: 'respan',
    status,
    ready: status === 'ready',
    reason,
    environment: options.environment,
    gateway: !!options.gateway,
    traceLlmRequests: !!options.traceLlmRequests,
    traceToolCalls: !!options.traceToolCalls,
    traceAgentSteps: !!options.traceAgentSteps,
    capturePayloads: !!options.capturePayloads,
    captureToolPayloads: !!options.captureToolPayloads,
    stats: { ...stats },
  };
}

/**
 * Where an optional gateway run should go, or null to use the provider directly.
 *
 * The Respan gateway is OpenAI-compatible and is addressed with the SDK's own base URL and the Respan key, as the
 * SDK's README shows. Only providers Respan documents as OpenAI-compatible are routed; Anthropic sign-ins, OAuth
 * plans and local models are never touched, so turning this on cannot break them.
 */
const GATEWAY_PROVIDERS = new Set(['openai', 'openrouter']);
export function gatewayTarget({ provider = null } = {}) {
  if (status !== 'ready' || !options.enabled || !options.gateway || !gatewayKey) return null;
  if (!GATEWAY_PROVIDERS.has(String(provider))) return null;
  return { baseUrl: options.baseURL, apiKey: gatewayKey };
}

/** Call each span's tracer; null when there is nothing active. Also used by tests through `sdkFactory`. */
function tracer() {
  return client ? client.getTracer() : null;
}

/** Run `fn` with console.log/info/debug muted. The SDK's banner goes to stdout, which is IPC in this app. */
async function withoutStdoutNoise(fn) {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  const mute = () => {};
  console.log = mute; console.info = mute; console.debug = mute;
  try {
    return await fn();
  } finally {
    console.log = saved.log; console.info = saved.info; console.debug = saved.debug;
  }
}

/**
 * Start (or restart) telemetry from settings. Never throws; resolves to the status.
 * `sdkFactory` is for tests: it returns { sdk, client } without loading the real package.
 */
export async function initRespan({
  enabled = false,
  apiKey = '',
  environment = 'development',
  baseURL = DEFAULT_BASE_URL,
  gateway = false,
  traceLlmRequests = true,
  traceToolCalls = true,
  traceAgentSteps = true,
  capturePayloads = true,
  captureToolPayloads = false,
  sampleRate = 1,
  appName = 'jarvis-v2',
  logger = null,
  sdkFactory = null,
} = {}) {
  await shutdownRespan({ quiet: true });
  options = {
    ...RESPAN_DEFAULTS,
    enabled: !!enabled,
    environment: environment === 'production' ? 'production' : 'development',
    baseURL: String(baseURL || DEFAULT_BASE_URL),
    gateway: !!gateway,
    traceLlmRequests: traceLlmRequests !== false,
    traceToolCalls: traceToolCalls !== false,
    traceAgentSteps: traceAgentSteps !== false,
    capturePayloads: capturePayloads !== false,
    captureToolPayloads: !!captureToolPayloads,
    sampleRate: Number.isFinite(Number(sampleRate)) ? Math.max(0, Math.min(1, Number(sampleRate))) : 1,
  };
  if (!options.enabled) { status = 'off'; reason = null; gatewayKey = null; return respanStatus(); }
  const key = String(apiKey ?? '').trim();
  if (!key) { status = 'not_configured'; reason = 'Respan is on but no API key is saved.'; return respanStatus(); }

  const run = (async () => {
    try {
      // Both construction and initialization run muted: the banner is written on the way in, not just at the end.
      await withoutStdoutNoise(async () => {
        if (sdkFactory) {
          const made = await sdkFactory({ apiKey: key, baseURL: options.baseURL, appName, traceContent: options.capturePayloads });
          sdk = made?.sdk ?? null;
          client = made?.client ?? null;
          return;
        }
        // Loaded only now: a person who never turns Respan on never pays for the SDK at startup.
        const mod = await import('@respan/respan');
        sdk = new mod.Respan({
          apiKey: key,
          baseURL: options.baseURL,
          appName,
          instrumentations: [], // JARVIS's providers go through gg-agent: no monkey-patching
          traceContent: options.capturePayloads,
          silenceInitializationMessage: true,
          logLevel: 'error',
        });
        await sdk.initialize();
        client = mod.getClient ? mod.getClient() : null;
        if (!client) { const t = await import('@respan/tracing'); client = t.getClient(); }
      });
      if (!client || typeof client.getTracer !== 'function') throw new Error('the Respan SDK did not provide a tracer');
      status = 'ready';
      reason = null;
      gatewayKey = key;
      stats.spans = 0;
    } catch (e) {
      sdk = null; client = null; gatewayKey = null;
      status = 'failed';
      reason = scrub(String(e?.message || e), 200);
      stats.lastError = reason;
      stats.errors++;
      logger?.({ type: 'respan_init_failed', reason });
    }
    return respanStatus();
  })();
  initializing = run;
  return run;
}

/** Await an initialization already in flight (a request arriving while the SDK starts). */
export async function respanReady() {
  if (initializing) await initializing.catch(() => {});
  return status === 'ready';
}

export function isRespanReady() { return status === 'ready'; }

// Kinds as Respan classifies spans.
const KIND = { workflow: 'workflow', agent: 'agent', chat: 'chat', tool: 'tool' };

function baseAttrs(kind, extra = {}) {
  return {
    'traceloop.span.kind': KIND[kind] ?? kind,
    'jarvis.environment': options.environment,
    ...extra,
  };
}

/**
 * Open one trace for a request. Returns null when telemetry is off, unsampled, or not ready - callers only ever
 * hand it straight back to the record* functions, so null is a complete answer.
 */
export function startRequestTrace({ sessionId = null, turn = null, provider = null, model = null } = {}) {
  if (status !== 'ready') { stats.skipped++; return null; }
  if (options.sampleRate <= 0) { stats.skipped++; return null; }
  if (options.sampleRate < 1 && Math.random() > options.sampleRate) { stats.skipped++; return null; }
  try {
    const t = tracer();
    if (!t) return null;
    const span = t.startSpan('jarvis.request', {
      attributes: baseAttrs('workflow', {
        ...(sessionId ? { 'respan.sessions.session_identifier': String(sessionId).slice(0, 120) } : {}),
        ...(turn != null ? { 'respan.trace.trace_group_identifier': `turn-${turn}` } : {}),
        ...(provider ? { 'gen_ai.system': String(provider).slice(0, 40) } : {}),
        ...(model ? { 'gen_ai.request.model': String(model).slice(0, 120) } : {}),
      }),
    });
    // Child spans get this context explicitly, so tool and LLM spans always land inside this request's trace
    // even though they are recorded from callbacks far from the code that opened it.
    const ctx = otelTrace.setSpan(context.active(), span);
    stats.traces++;
    return { span, ctx, sessionId, turn, provider, model, startedAt: Date.now(), spans: 0 };
  } catch (e) {
    stats.errors++; stats.lastError = scrub(String(e?.message || e), 200);
    return null;
  }
}

function child(trace, name, attributes) {
  const t = tracer();
  if (!t) return null;
  const span = t.startSpan(name, { attributes }, trace?.ctx);
  return span;
}

function finish(span, { ok = true, message = null } = {}) {
  if (!span) return;
  try {
    // 1 = OK, 2 = ERROR (OpenTelemetry SpanStatusCode); literal so no extra import is required.
    span.setStatus({ code: ok ? 1 : 2, ...(message ? { message: scrub(String(message), 300) } : {}) });
    span.end();
    stats.spans++;
  } catch (e) { stats.errors++; stats.lastError = scrub(String(e?.message || e), 200); }
}

/** Close the request's trace. `ok: false` marks the whole request failed; the message is scrubbed. */
export function endRequestTrace(trace, { ok = true, error = null } = {}) {
  if (!trace?.span) return;
  try {
    trace.span.setAttributes?.({
      ...(trace.spans ? { 'jarvis.spans': trace.spans } : {}),
      'jarvis.ms': Math.max(0, Date.now() - trace.startedAt),
    });
  } catch { /* an attribute never fails a request */ }
  finish(trace.span, { ok, message: error });
  trace.span = null;
}

/** One LLM turn: model, provider, tokens, latency. The turn's own words only with capturePayloads. */
export function recordLlmTurn(trace, { provider = null, model = null, usage = null, ms = null, input = null, output = null, error = null } = {}) {
  if (!trace?.span || !options.traceLlmRequests) return;
  try {
    const u = usage || {};
    const attrs = baseAttrs('chat', {
      'llm.request.type': 'chat',
      ...(provider ? { 'gen_ai.system': String(provider).slice(0, 40) } : {}),
      ...(model ? { 'gen_ai.request.model': String(model).slice(0, 120) } : {}),
      ...(Number.isFinite(u.inputTokens) ? { 'gen_ai.usage.prompt_tokens': Math.max(0, Math.trunc(u.inputTokens)) } : {}),
      ...(Number.isFinite(u.outputTokens) ? { 'gen_ai.usage.completion_tokens': Math.max(0, Math.trunc(u.outputTokens)) } : {}),
      ...(Number.isFinite(u.cacheRead) ? { 'jarvis.usage.cache_read': Math.max(0, Math.trunc(u.cacheRead)) } : {}),
      ...(Number.isFinite(ms) ? { 'jarvis.ms': Math.max(0, Math.trunc(ms)) } : {}),
    });
    if (options.capturePayloads) {
      if (typeof input === 'string' && input) attrs['traceloop.entity.input'] = scrub(input);
      if (typeof output === 'string' && output) attrs['traceloop.entity.output'] = scrub(output);
    }
    const span = child(trace, 'jarvis.llm', attrs);
    trace.spans++;
    finish(span, { ok: !error, message: error });
  } catch (e) { stats.errors++; stats.lastError = scrub(String(e?.message || e), 200); }
}

/** One tool call. Arguments/results only with captureToolPayloads; secrets are removed first, always. */
export function recordToolCall(trace, { name = 'tool', args = null, result = null, ms = null, isError = false, denied = false, reason = null } = {}) {
  if (!trace?.span || !options.traceToolCalls) return;
  try {
    const attrs = baseAttrs('tool', {
      'traceloop.entity.name': String(name).slice(0, 80),
      ...(Number.isFinite(ms) ? { 'jarvis.tool.ms': Math.max(0, Math.trunc(ms)) } : {}),
      ...(denied ? { 'jarvis.tool.denied': true } : {}),
    });
    if (options.captureToolPayloads) {
      const redacted = args && typeof args === 'object' ? redactArgs(name, args) : args;
      if (redacted != null) attrs['traceloop.entity.input'] = scrub(typeof redacted === 'string' ? redacted : JSON.stringify(redacted), MAX_ARGS);
      if (result != null) attrs['traceloop.entity.output'] = scrub(typeof result === 'string' ? result : JSON.stringify(result), MAX_RESULT);
    }
    const span = child(trace, `jarvis.tool.${String(name).slice(0, 60)}`, attrs);
    trace.spans++;
    finish(span, { ok: !isError && !denied, message: reason });
  } catch (e) { stats.errors++; stats.lastError = scrub(String(e?.message || e), 200); }
}

/** One planned step (the executor's own view: started/completed/failed/denied). */
export function recordAgentStep(trace, { title = 'step', status: stepStatus = 'completed', ms = null } = {}) {
  if (!trace?.span || !options.traceAgentSteps) return;
  try {
    const bad = stepStatus === 'failed' || stepStatus === 'denied' || stepStatus === 'cancelled';
    const attrs = baseAttrs('agent', {
      'traceloop.entity.name': String(title).slice(0, 120),
      'jarvis.step.status': String(stepStatus).slice(0, 40),
      ...(Number.isFinite(ms) ? { 'jarvis.ms': Math.max(0, Math.trunc(ms)) } : {}),
    });
    const span = child(trace, 'jarvis.step', attrs);
    trace.spans++;
    finish(span, { ok: !bad, message: bad ? stepStatus : null });
  } catch (e) { stats.errors++; stats.lastError = scrub(String(e?.message || e), 200); }
}

/** Send what is buffered now. Safe (and quick) when telemetry is off. */
export async function flushRespan({ timeoutMs = 2500 } = {}) {
  if (!sdk || typeof sdk.flush !== 'function') return false;
  try {
    await Promise.race([
      sdk.flush(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('flush timeout')), Math.max(200, timeoutMs))),
    ]);
    return true;
  } catch (e) {
    stats.errors++; stats.lastError = scrub(String(e?.message || e), 200);
    return false;
  }
}

/** Shut the SDK down (quit, or a settings change). Never throws. */
export async function shutdownRespan({ quiet = false } = {}) {
  const had = sdk;
  sdk = null; client = null; initializing = null; gatewayKey = null;
  if (status === 'ready') status = 'off';
  if (!had || typeof had.shutdown !== 'function') return;
  try { await had.shutdown(); } catch (e) { if (!quiet) { stats.errors++; stats.lastError = scrub(String(e?.message || e), 200); } }
}

/** Test seam: forget everything without touching the SDK. */
export function _resetRespanForTests() {
  sdk = null; client = null; reason = null; status = 'off'; options = { ...RESPAN_DEFAULTS }; initializing = null; gatewayKey = null;
  Object.assign(stats, { traces: 0, spans: 0, errors: 0, skipped: 0, lastError: null });
}
