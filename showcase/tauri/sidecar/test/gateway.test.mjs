// The gateway client the side calls use (gateway.mjs): the route it reads from the environment, and a
// chat turn against a fake gateway — the same OpenAI-compatible endpoint the Respan Gateway serves.
// The live end-to-end check against the real Python gateway is `npm run test:gateway` (test/gateway-smoke.mjs).
import assert from 'node:assert/strict';
import http from 'node:http';
import { contentText, errorLine, gatewayComplete, gatewayRoute, DEFAULT_GATEWAY_URL } from '../gateway.mjs';
import { oneShot } from '../brain.mjs';

// Off unless asked for: the side calls keep the app's own sign-in.
assert.equal(gatewayRoute({}), null);
assert.equal(gatewayRoute({ ROAMIES_GATEWAY: '0' }), null, '0 is off');
assert.deepEqual(gatewayRoute({ ROAMIES_GATEWAY: '1' }), { url: DEFAULT_GATEWAY_URL, key: null, model: null, timeout: 120_000 });
assert.equal(gatewayRoute({ ROAMIES_GATEWAY_URL: 'http://127.0.0.1:9000//' }).url, 'http://127.0.0.1:9000', 'trailing slashes are dropped');
assert.deepEqual(
  gatewayRoute({ ROAMIES_GATEWAY_URL: ' http://127.0.0.1:9000 ', ROAMIES_GATEWAY_KEY: ' sk-gw-abc ', ROAMIES_GATEWAY_MODEL: 'roamies-side', ROAMIES_GATEWAY_TIMEOUT_MS: '5000' }),
  { url: 'http://127.0.0.1:9000', key: 'sk-gw-abc', model: 'roamies-side', timeout: 5000 },
);
assert.equal(gatewayRoute({ ROAMIES_GATEWAY_URL: 'http://127.0.0.1:9000' }).timeout, 120_000, 'a nonsense budget falls back');
assert.equal(gatewayRoute({ ROAMIES_GATEWAY_URL: 'http://127.0.0.1:9000', ROAMIES_GATEWAY_TIMEOUT_MS: '-1' }).timeout, 120_000);

// A reply's text, however OpenAI shaped it; the error line from whatever the gateway sent.
assert.equal(contentText('hi'), 'hi');
assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
assert.equal(contentText(null), '');
assert.equal(contentText([{ type: 'image_url' }]), '');
assert.equal(errorLine('{"error":{"message":"model not found"}}'), 'model not found');
assert.equal(errorLine('upstream   said\nno'), 'upstream said no');
assert.equal(errorLine(''), '');

// A fake gateway: what the real one answers on /v1/chat/completions, and what it was asked.
const seen = [];
let hang = false; // the next request gets no answer at all
let reply = (body) => ({ status: 200, body: { choices: [{ index: 0, message: { role: 'assistant', content: '{"facts":[]}' } }], model: body.model } });
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions');
    const body = JSON.parse(raw);
    seen.push({ authorization: req.headers.authorization ?? null, body });
    if (hang) return;
    const { status, body: out } = reply(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof out === 'string' ? out : JSON.stringify(out));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

// The turn: system and user messages, the model asked for, no key unless one is set.
assert.equal(await gatewayComplete({ url, model: 'roamies-side', system: 'fold this', text: 'turns' }), '{"facts":[]}');
assert.deepEqual(seen[0], {
  authorization: null,
  body: { model: 'roamies-side', messages: [{ role: 'system', content: 'fold this' }, { role: 'user', content: 'turns' }], stream: false },
}, 'a client key is only sent when the gateway sets one');
await gatewayComplete({ url: `${url}/`, model: 'm', text: 't', key: 'sk-gw-abc' });
assert.equal(seen[1].authorization, 'Bearer sk-gw-abc');
assert.deepEqual(seen[1].body.messages, [{ role: 'user', content: 't' }], 'no system message when there is none');

// Failures name themselves, so a log line can say what went wrong.
reply = () => ({ status: 400, body: { error: { message: 'no provider for model m' } } });
await assert.rejects(gatewayComplete({ url, model: 'm', text: 't' }), /gateway_400: no provider for model m/);
reply = () => ({ status: 200, body: { choices: [{ message: { role: 'assistant', content: '  ' } }] } });
await assert.rejects(gatewayComplete({ url, model: 'm', text: 't' }), /gateway_empty_reply/);
reply = () => ({ status: 200, body: '<html>not json</html>' });
await assert.rejects(gatewayComplete({ url, model: 'm', text: 't' }), /gateway_bad_reply/);
await assert.rejects(gatewayComplete({ url: 'http://127.0.0.1:1', model: 'm', text: 't', timeout: 2000 }), /gateway_unreachable/);
hang = true; // never answers
await assert.rejects(gatewayComplete({ url, model: 'm', text: 't', timeout: 60 }), /gateway_timeout/);
hang = false;
reply = (body) => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }], model: body.model } });

// The side calls: a gateway route answers the fold/memory turn, asking the summary model when the route
// names none, and the app's own sign-in answers when the gateway cannot.
{
  const out = await oneShot({ provider: 'anthropic', model: 'claude-opus-5-5', system: 's', text: 't', gateway: { url, key: null, model: null, timeout: 5000 } });
  assert.deepEqual(out, { text: 'ok', model: 'claude-sonnet-5-5' }, 'the summary model, through the gateway');
  assert.equal(seen.at(-1).body.model, 'claude-sonnet-5-5');
  const routed = await oneShot({ provider: 'anthropic', model: 'claude-opus-5-5', system: 's', text: 't', gateway: { url, key: null, model: 'roamies-side', timeout: 5000 } });
  assert.deepEqual(routed, { text: 'ok', model: 'roamies-side' }, 'a named route is what the gateway gets');
  assert.equal(seen.at(-1).body.model, 'roamies-side');

  const tried = [];
  const fallback = await oneShot({
    provider: 'anthropic', model: 'claude-opus-5-5', system: 's', text: 't',
    gateway: { url: 'http://127.0.0.1:1', key: null, model: null, timeout: 2000 },
    run: async (o) => { tried.push(o.model); return '{"facts":[]}'; },
  });
  assert.deepEqual(fallback, { text: '{"facts":[]}', model: 'claude-sonnet-5-5' }, 'the own sign-in answers when the gateway is down');
  assert.deepEqual(tried, ['claude-sonnet-5-5']);
}

server.close();
console.log('gateway tests: passed');
