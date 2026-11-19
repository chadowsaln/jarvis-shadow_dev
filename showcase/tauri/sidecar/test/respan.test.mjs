// Respan telemetry: span shape, parenting, privacy, and never failing a request. Run: npm test
//
// The real SDK is never loaded here (it would export to the network): `initRespan` takes an `sdkFactory`, which is
// exactly the seam the live app uses for the vendor package. Nothing about the wiring is stubbed.
import assert from 'node:assert/strict';
import { trace as otelTrace } from '@opentelemetry/api';
import {
  RESPAN_DEFAULTS, _resetRespanForTests, endRequestTrace, flushRespan, initRespan, isRespanReady,
  recordAgentStep, recordLlmTurn, recordToolCall, respanStatus, scrub, shutdownRespan, startRequestTrace,
} from '../respan.mjs';

const fakeSdk = () => {
  const spans = [];
  const calls = { flush: 0, shutdown: 0 };
  const tracer = {
    startSpan(name, opts = {}, parentCtx) {
      const span = {
        name, attributes: { ...(opts.attributes || {}) }, parentCtx: parentCtx ?? null,
        status: null, ended: false,
        setAttributes(a) { Object.assign(this.attributes, a); },
        setStatus(s) { this.status = s; },
        end() { this.ended = true; },
        recordException() {},
      };
      spans.push(span);
      return span;
    },
  };
  const client = { getTracer: () => tracer, getCurrentTraceId: () => 'a'.repeat(32), getCurrentSpanId: () => 'b'.repeat(16) };
  const sdk = { flush: async () => { calls.flush++; }, shutdown: async () => { calls.shutdown++; } };
  return { made: { sdk, client }, spans, calls };
};

const ready = async (extra = {}) => {
  _resetRespanForTests();
  const f = fakeSdk();
  const st = await initRespan({ enabled: true, apiKey: 'rsp-live-do-not-log', sdkFactory: () => f.made, ...extra });
  assert.equal(st.status, 'ready', st.reason || 'should initialize');
  return { ...f, status: st };
};

// ---------------------------------------------------------------- disabled and unconfigured are quiet
{
  _resetRespanForTests();
  const off = respanStatus();
  assert.equal(off.status, 'off');
  assert.equal(off.stats.traces, 0);
  assert.equal(startRequestTrace({ sessionId: 's', turn: 1 }), null, 'nothing is traced when off');
  assert.equal(await flushRespan(), false);
  await shutdownRespan();
  assert.equal(isRespanReady(), false);

  const noKey = await initRespan({ enabled: true, apiKey: '' });
  assert.equal(noKey.status, 'not_configured');
  assert.match(noKey.reason, /no API key/i);
  assert.equal(startRequestTrace({}), null);
  // Never a key in the status the panel or a log may show.
  assert.equal(JSON.stringify(noKey).includes('rsp-'), false);
  console.log('off and unconfigured: passed');
}

// ---------------------------------------------------------------- a failing SDK is contained
{
  _resetRespanForTests();
  const st = await initRespan({ enabled: true, apiKey: 'rsp-x', sdkFactory: () => { throw new Error('boom Bearer abcdefghijkl'); } });
  assert.equal(st.status, 'failed');
  assert.match(st.reason, /boom/);
  assert.equal(/abcdefghijkl/.test(st.reason), false, 'a token in the error is removed');
  assert.equal(startRequestTrace({}), null);
  console.log('init failure: passed');
}

// ---------------------------------------------------------------- the SDK's banner never reaches stdout
{
  _resetRespanForTests();
  const printed = [];
  const realLog = console.log, realInfo = console.info, realDebug = console.debug;
  try {
    // A factory that behaves like the real package on initialize: a banner on stdout.
    const f = fakeSdk();
    await initRespan({
      enabled: true, apiKey: 'rsp-x',
      sdkFactory: async () => { console.log('[Respan Debug] Tracing configuration: {}'); console.info('[Respan Debug] trace content enabled'); console.debug('[Respan Debug] more'); return f.made; },
    });
    console.log = (...a) => printed.push(a.join(' '));
  } finally {
    console.log = realLog; console.info = realInfo; console.debug = realDebug;
  }
  assert.deepEqual(printed.filter((l) => l.includes('[Respan Debug]')), [], 'no SDK banner on stdout (it is IPC here)');
  assert.equal(respanStatus().status, 'ready');
  console.log('stdout guarded: passed');
}

// ---------------------------------------------------------------- the span tree
{
  const { spans, status } = await ready({ environment: 'production' });
  assert.equal(status.environment, 'production');
  // The key must not be in the status, ever.
  assert.equal(JSON.stringify(status).includes('rsp-live-do-not-log'), false);

  const trace = startRequestTrace({ sessionId: 'sess-42', turn: 7, provider: 'anthropic', model: 'claude-sonnet-5' });
  assert.ok(trace, 'a trace is opened');
  const req = spans.find((s) => s.name === 'jarvis.request');
  assert.equal(req.attributes['traceloop.span.kind'], 'workflow');
  assert.equal(req.attributes['respan.sessions.session_identifier'], 'sess-42');
  assert.equal(req.attributes['respan.trace.trace_group_identifier'], 'turn-7');
  assert.equal(req.attributes['gen_ai.system'], 'anthropic');
  assert.equal(req.attributes['jarvis.environment'], 'production');

  recordLlmTurn(trace, { provider: 'anthropic', model: 'claude-sonnet-5', usage: { inputTokens: 1200, outputTokens: 90, cacheRead: 800 }, ms: 1400, input: 'my card is 4111 1111 1111 1111', output: 'Sure.' });
  const llm = spans.find((s) => s.name === 'jarvis.llm');
  assert.equal(llm.attributes['llm.request.type'], 'chat');
  assert.equal(llm.attributes['gen_ai.usage.prompt_tokens'], 1200);
  assert.equal(llm.attributes['gen_ai.usage.completion_tokens'], 90);
  assert.equal(llm.attributes['jarvis.usage.cache_read'], 800);
  assert.equal(llm.attributes['jarvis.ms'], 1400);
  // Parented to the request span, not a new trace.
  assert.equal(otelTrace.getSpan(llm.parentCtx), req, 'the LLM span nests under the request');
  assert.equal(llm.status.code, 1);

  // Payloads: the LLM turn's words are captured (that is what evaluation needs) and scrubbed.
  assert.match(llm.attributes['traceloop.entity.input'], /4111 1111/);
  assert.ok(llm.attributes['traceloop.entity.input'].length <= 2000);

  recordToolCall(trace, { name: 'read_file', args: { path: '/home/me/notes.md', token: 'rsp-should-not-appear' }, result: 'file text', ms: 42, isError: false });
  const tool = spans.find((s) => s.name === 'jarvis.tool.read_file');
  assert.equal(tool.attributes['traceloop.entity.name'], 'read_file');
  assert.equal(tool.attributes['jarvis.tool.ms'], 42);
  assert.equal(tool.attributes['traceloop.entity.input'], undefined, 'tool payloads stay local by default');
  assert.equal(tool.attributes['traceloop.entity.output'], undefined);
  assert.equal(JSON.stringify(spans).includes('rsp-should-not-appear'), false);

  recordToolCall(trace, { name: 'write_file', isError: true, reason: 'disk full' });
  const bad = spans.find((s) => s.name === 'jarvis.tool.write_file');
  assert.equal(bad.status.code, 2);
  assert.match(bad.status.message, /disk full/);
  // A denial is an error span with the reason, so observability shows what was refused.
  recordToolCall(trace, { name: 'run_command', denied: true, reason: 'insufficient permission level' });
  const denied = spans.find((s) => s.name === 'jarvis.tool.run_command');
  assert.equal(denied.attributes['jarvis.tool.denied'], true);
  assert.equal(denied.status.code, 2);

  recordAgentStep(trace, { title: 'Read the file', status: 'completed' });
  recordAgentStep(trace, { title: 'Write the file', status: 'failed' });
  const steps = spans.filter((s) => s.name === 'jarvis.step');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].attributes['traceloop.span.kind'], 'agent');
  assert.equal(steps[0].status.code, 1);
  assert.equal(steps[1].status.code, 2);

  endRequestTrace(trace, { ok: false, error: 'provider timeout' });
  assert.equal(req.status.code, 2);
  assert.match(req.status.message, /provider timeout/);
  assert.equal(req.attributes['jarvis.spans'], 6, 'the request counts its child spans (llm, 3 tools, 2 steps)');
  assert.ok(req.ended);
  assert.equal(trace.span, null, 'a closed trace is not used again');
  // Recording after close is a no-op, not a crash.
  recordToolCall(trace, { name: 'late' });
  assert.equal(spans.filter((s) => s.name === 'jarvis.tool.late').length, 0);
  console.log('span tree: passed');
}

// ---------------------------------------------------------------- tool payloads, when switched on
{
  const { spans } = await ready({ captureToolPayloads: true, capturePayloads: true });
  const trace = startRequestTrace({ sessionId: 's', turn: 1 });
  recordToolCall(trace, { name: 'run_command', args: { command: 'cat ~/.netrc', apiKey: 'rsp-very-secret-value' }, result: 'machine github login', ms: 5 });
  const tool = spans.find((s) => s.name.startsWith('jarvis.tool.'));
  assert.match(tool.attributes['traceloop.entity.input'], /cat ~\/\.netrc/, 'the argument is there when asked for');
  assert.equal(/rsp-very-secret-value/.test(tool.attributes['traceloop.entity.input']), false, 'the key is redacted first');
  assert.match(tool.attributes['traceloop.entity.output'], /machine github/);
  assert.ok(tool.attributes['traceloop.entity.input'].length <= 600);
  console.log('tool payloads: passed');
}

// ---------------------------------------------------------------- per-signal switches
{
  const { spans } = await ready({ traceLlmRequests: false, traceToolCalls: false });
  const trace = startRequestTrace({ sessionId: 's', turn: 2 });
  recordLlmTurn(trace, { model: 'm', usage: { inputTokens: 1 } });
  recordToolCall(trace, { name: 'open' });
  assert.equal(spans.filter((s) => s.name === 'jarvis.llm').length, 0, 'LLM spans can be off on their own');
  assert.equal(spans.filter((s) => s.name.startsWith('jarvis.tool.')).length, 0, 'tool spans too');
  assert.deepEqual(respanStatus().stats.traces, 1);
  assert.equal(spans.length, 1, 'the request span still opens');
  console.log('per-signal switches: passed');
}

// ---------------------------------------------------------------- sampling, flush and shutdown
{
  const { calls } = await ready({ sampleRate: 0 });
  assert.equal(startRequestTrace({}), null, 'sample rate 0 traces nothing');
  assert.equal(respanStatus().stats.skipped >= 1, true);
  assert.equal(await flushRespan(), true);
  assert.equal(calls.flush, 1);
  await shutdownRespan();
  assert.equal(calls.shutdown, 1);
  assert.equal(isRespanReady(), false);
  // After shutdown nothing throws and nothing is traced.
  assert.equal(startRequestTrace({}), null);
  assert.equal(await flushRespan(), false);
  console.log('sampling and lifecycle: passed');
}

// ---------------------------------------------------------------- scrub itself
{
  assert.equal(scrub('key sk-abcdef123456 and rsp-abcdef123456', 100), 'key [redacted] and [redacted]');
  assert.equal(scrub('mail me at ken@example.com', 100), 'mail me at [email]');
  assert.equal(scrub('Bearer abcdefghijklmnop', 100), '[redacted]');
  assert.ok(scrub('x'.repeat(5000)).length <= 2000);
  assert.deepEqual(RESPAN_DEFAULTS.gateway, false);
  assert.deepEqual(RESPAN_DEFAULTS.captureToolPayloads, false);
}

console.log('respan tests: all passed');
