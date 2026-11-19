// Phase 3: one research request, seen end to end — Exa retrieves, JARVIS records, Respan receives one trace.
//
// Two halves, both real:
// - The wiring half reads sidekick.mjs and asserts that the hooks are where they must be (a request opens a trace, the
//   usage event records the model turn, tool start/end record the tool span, the executor's own events record steps,
//   and every exit path closes the trace). A deleted line here is a silently untraced request.
// - The run half drives the real Exa functions with a fake fetch and puts their results through the real span
//   recorder with a fake SDK, then inspects the tree: a workflow span with a tool span per retrieval and a chat span
//   under it, no key anywhere, and a failed call that is an error span rather than a silence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { trace as otelTrace } from '@opentelemetry/api';
import { _resetRespanForTests, endRequestTrace, initRespan, recordAgentStep, recordLlmTurn, recordToolCall, startRequestTrace } from '../respan.mjs';
import { exaGetContents, exaSearch, setExaKey } from '../exa.mjs';

const SIDE = readFileSync(fileURLToPath(new URL('../sidekick.mjs', import.meta.url)), 'utf8');

// ---------------------------------------------------------------- the hooks exist, once each, where they belong
{
  const hook = (re, what) => assert.ok(re.test(SIDE), what);
  hook(/import \{ initRespan, respanStatus, startRequestTrace, endRequestTrace, recordLlmTurn, recordToolCall, recordAgentStep, flushRespan, shutdownRespan, gatewayTarget \} from '\.\/respan\.mjs'/, 'the sidecar imports the recorder');
  hook(/await respanBootP\.catch\(\(\) => \{\}\);\n\s+await exaLoaded\.catch\(\(\) => \{\}\);\n\s+currentTrace = startRequestTrace\(\{ sessionId: session\?\.id \?\? null, turn, provider: config\.provider, model: config\.model \}\)/, 'a request opens a trace with the conversation id and turn');
  hook(/recordLlmTurn\(currentTrace, \{ provider: config\.provider, model: config\.model, usage: u/, 'the usage event records the model turn');
  hook(/if \(currentTrace\) traceToolStart\.set\(e\.toolCallId/, 'a tool start remembers when it began');
  hook(/recordToolCall\(currentTrace, \{ name: st\.name, args: st\.args/, 'the tool end records the tool span');
  hook(/function logAgentCore\(e\)[\s\S]{0,400}recordAgentStep\(currentTrace/, "the executor's step events become step spans");
  hook(/endRequestTrace\(currentTrace, \{ ok: !controller\.signal\.aborted/, 'a finished request closes its trace');
  hook(/catch \(err\) \{\n\s+lastFailed = true;\n\s+endRequestTrace\(currentTrace, \{ ok: false/, 'a failed request closes its trace as an error');
  // Quit sends what is buffered before the process goes away.
  hook(/if \(id === 'quit'\) \{ await flushRespan\(\{ timeoutMs: 800 \}\)/, 'quit flushes first');
  // Gateway mode only reaches providers it is meant to, and never replaces the direct path.
  hook(/const gw = gatewayTarget\(\{ provider: config\.provider \}\);\n\s+if \(gw\) return \{ apiKey: gw\.apiKey \};/, 'gateway mode supplies the gateway key only when it routes');
  assert.equal((SIDE.match(/recordToolCall\(currentTrace/g) || []).length, 1, 'a tool call is recorded exactly once');
  console.log('wiring: passed');
}

const fakeSdk = () => {
  const spans = [];
  const tracer = {
    startSpan(name, opts = {}, parentCtx) {
      const span = {
        name, attributes: { ...(opts.attributes || {}) }, parentCtx: parentCtx ?? null, status: null, ended: false,
        setAttributes(a) { Object.assign(this.attributes, a); }, setStatus(s) { this.status = s; }, end() { this.ended = true; }, recordException() {},
      };
      spans.push(span);
      return span;
    },
  };
  const client = { getTracer: () => tracer, getCurrentTraceId: () => 'a'.repeat(32), getCurrentSpanId: () => 'b'.repeat(16) };
  const sdk = { flush: async () => {}, shutdown: async () => {} };
  return { made: { sdk, client }, spans };
};

// ---------------------------------------------------------------- Exa retrieved, JARVIS recorded, Respan saw it
{
  _resetRespanForTests();
  const f = fakeSdk();
  const st = await initRespan({ enabled: true, apiKey: 'rsp-trace-key-never-logged', sdkFactory: () => f.made, capturePayloads: true });
  assert.equal(st.status, 'ready');

  const KEY = 'exa-live-key-never-logged';
  setExaKey(KEY);

  const results = {
    '/search': { results: [{ title: 'Humanoid robots', url: 'https://news.example/humanoids', text: 'a new humanoid', score: 0.9 }], costDollars: { total: 0.005 } },
    '/contents': { results: [{ title: 'Humanoid robots', url: 'https://news.example/humanoids', text: 'Full article text about humanoids.', status: 'success', summary: 'Humanoids are getting cheaper.' }], statuses: [{ id: 'https://news.example/humanoids', status: 'success' }] },
  };
  const fetchImpl = async (url, init) => {
    const path = Object.keys(results).find((p) => String(url).endsWith(p));
    assert.ok(path, `unexpected request to ${url}`);
    assert.equal(init.headers['x-api-key'], KEY, 'the saved key is used');
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => results[path] };
  };

  // The request, exactly as prompt() opens it.
  const trace = startRequestTrace({ sessionId: 'sess-research', turn: 3, provider: 'anthropic', model: 'claude-sonnet-5' });

  const search = await exaSearch({ query: 'latest humanoid robotics', numResults: 3 }, { fetchImpl });
  recordToolCall(trace, { name: 'exa_search', args: { query: 'latest humanoid robotics' }, result: { count: search.count }, ms: 12 });
  assert.equal(search.ok, true);

  const read = await exaGetContents({ urls: [search.results[0].url], summary: 'what changed' }, { fetchImpl });
  recordToolCall(trace, { name: 'exa_get_contents', args: { urls: [search.results[0].url] }, result: { count: read.count }, ms: 20 });
  assert.equal(read.ok, true);
  assert.match(read.results[0].summary, /cheaper/);

  recordLlmTurn(trace, { provider: 'anthropic', model: 'claude-sonnet-5', usage: { inputTokens: 2000, outputTokens: 180 }, ms: 2400, input: 'research humanoid robotics', output: 'They are getting cheaper, per [news.example].' });
  recordAgentStep(trace, { title: 'exa_search', status: 'completed' });
  endRequestTrace(trace, { ok: true });

  const req = f.spans.find((s) => s.name === 'jarvis.request');
  assert.equal(req.attributes['respan.sessions.session_identifier'], 'sess-research');
  assert.equal(req.attributes['respan.trace.trace_group_identifier'], 'turn-3');
  const tools = f.spans.filter((s) => s.name.startsWith('jarvis.tool.'));
  assert.deepEqual(tools.map((s) => s.attributes['traceloop.entity.name']), ['exa_search', 'exa_get_contents'], 'both retrievals are tool spans, in order');
  const chat = f.spans.find((s) => s.name === 'jarvis.llm');
  assert.equal(otelTrace.getSpan(chat.parentCtx), req, 'the model turn is inside the same trace');
  assert.equal(otelTrace.getSpan(tools[0].parentCtx), req, 'the retrievals are inside the same trace too');
  assert.equal(f.spans.filter((s) => s.name === 'jarvis.step').length, 1);
  assert.equal(req.attributes['jarvis.spans'], 4, 'two tools, a model turn and a step');
  assert.ok(f.spans.every((s) => s.ended), 'every span is closed');
  const everything = JSON.stringify(f.spans);
  assert.equal(everything.includes(KEY), false, 'the Exa key is in no span');
  assert.equal(everything.includes('rsp-trace-key-never-logged'), false, 'the Respan key is in no span');

  // A refused call is an error span with its reason: observability never shows a failed retrieval as a success.
  const trace2 = startRequestTrace({ sessionId: 'sess-research', turn: 4, provider: 'anthropic', model: 'claude-sonnet-5' });
  setExaKey('exa-bad');
  const denied = await exaSearch({ query: 'q' }, { fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => 'application/json' }, json: async () => ({ error: { message: 'invalid api key' } }) }) });
  assert.equal(denied.ok, false);
  recordToolCall(trace2, { name: 'exa_search', args: { query: 'q' }, ms: 3, isError: true, reason: denied.error });
  endRequestTrace(trace2, { ok: true });
  const failed = f.spans.filter((s) => s.name === 'jarvis.tool.exa_search').pop();
  assert.equal(failed.status.code, 2, 'the failed search is an error span');
  assert.match(failed.status.message, /invalid api key/);

  // Nothing about the run makes the next request depend on Respan: with telemetry off, Exa still answers.
  setExaKey(KEY);
  _resetRespanForTests();
  assert.equal(startRequestTrace({ sessionId: 's', turn: 5 }), null, 'telemetry off opens no trace');
  const still = await exaSearch({ query: 'q' }, { fetchImpl });
  assert.equal(still.ok, true, 'Exa works with Respan off');
  setExaKey(null);
  assert.equal(JSON.stringify(still).includes(KEY), false, 'no key in the tool result either');
  console.log('research across both services: passed');
}

console.log('respan trace tests: all passed');
