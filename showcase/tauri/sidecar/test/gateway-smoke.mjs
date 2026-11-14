// Live end-to-end check of the side-call gateway: a local provider fixture ← the real Respan Gateway
// (gateway/serve.py) ← brain.mjs's oneShot, the call the fold and the memory pass make. No provider key
// and no network: the fixture stands in for the provider, and the gateway's config points at it.
//
//   npm run test:gateway        (needs gateway/.venv; see gateway/requirements.txt)
//
// Exits 0 with "passed" once the answer came back through the gateway, or with "skipped" when the
// project's Python environment is not installed — never a pass, and never a failure for that reason.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneShot } from '../brain.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const gatewayDir = path.join(here, '..', 'gateway');
const python = process.platform === 'win32'
  ? path.join(gatewayDir, '.venv', 'Scripts', 'python.exe')
  : path.join(gatewayDir, '.venv', 'bin', 'python');

if (!fs.existsSync(python)) {
  console.log(`gateway smoke: skipped — ${python} is missing. Install it with:\n` +
    '  python3 -m venv gateway/.venv && gateway/.venv/bin/pip install --only-binary=:all: -r gateway/requirements.txt');
  process.exit(0);
}

// The provider the gateway routes to: OpenAI's chat format, answering like a summary would.
const ANSWER = '{"summary":"The user asked for a summary.","facts":[]}';
const asked = [];
const fixture = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === 'GET') { // the model list the gateway fetches at start
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] }));
      return;
    }
    asked.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-fixture', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;

// The gateway's config: one OpenAI-compatible provider (the fixture) and a route the side calls ask for.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-gateway-'));
const config = path.join(dir, 'gateway.toml');
fs.writeFileSync(config, `listen = "127.0.0.1:0"

[providers.fixture]
formats = ["openai-chat"]
base_url = "${fixtureUrl}/v1"

[routes.roamies-side]
to = "fixture/fixture-model"
`);

const child = spawn(python, [path.join(gatewayDir, 'serve.py'), '--config', config, '--port', '0'], {
  cwd: path.join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (c) => { stderr += c; });
const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));

// serve.py prints the address on its own first stdout line, once it is listening.
const url = await new Promise((resolve, reject) => {
  let out = '';
  const timer = setTimeout(() => reject(new Error(`the gateway did not start in 20s\n${stderr}`)), 20_000);
  child.stdout.on('data', (c) => {
    out += c;
    const line = out.split('\n')[0].trim();
    if (!line) return;
    clearTimeout(timer);
    resolve(line);
  });
  child.on('exit', () => { clearTimeout(timer); reject(new Error(`the gateway exited before listening\n${stderr}`)); });
});
assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/, 'a loopback address');

// The app path: the side call brain.mjs makes, with the route sideRoute() would add.
const out = await oneShot({
  provider: 'anthropic', model: 'claude-opus-5-5', system: 'fold these turns', text: 'user: hi',
  gateway: { url, key: null, model: 'roamies-side', timeout: 30_000 },
});
assert.equal(out.model, 'roamies-side', 'the gateway was asked for the configured route');
assert.equal(out.text, ANSWER, 'the provider fixture\'s answer came back through the gateway');
assert.equal(asked.length, 1, 'the fixture was called exactly once');
assert.deepEqual(asked[0].messages, [{ role: 'system', content: 'fold these turns' }, { role: 'user', content: 'user: hi' }]);
assert.equal(asked[0].model, 'fixture-model', 'the route sent it to the fixture\'s model');

child.kill('SIGTERM');
const end = await exited;
assert.equal(end.code, 0, `the gateway stopped cleanly (${JSON.stringify(end)})\n${stderr}`);
fixture.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`gateway smoke: passed — ${url} routed roamies-side → fixture/fixture-model, answer: ${out.text}`);
