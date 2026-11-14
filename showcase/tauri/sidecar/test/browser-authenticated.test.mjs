// Batch 9.1: authenticated Respan browser reading via safe local bridge interface (no extension install possible here).
// Verifies: bridge discovery/config, consent/approval gating, Respan-only scoped reads of visible content
// (title/url/text/elements) through a mock local bridge, no credential extraction, login/CAPTCHA not bypassed,
// clear failure when unavailable. No network to real Respan, no account data touched.
import assert from 'node:assert/strict';
import http from 'node:http';
import { agentCorePreflight } from '../agentcore/preflight.mjs';
import { createAgentCoreRuntime } from '../agentcore/runtime.mjs';
import { createApprovalChannel } from '../agentcore/approval-channel.mjs';
import { createTools } from '../tools.mjs';
import { describe } from '../activity.mjs';
import { getRespanBridgeConfig, isRespanPlatformUrl, readRespanAuthenticatedPage, respanBridgeStatus, sanitizeBridgeSnapshot } from '../browser.mjs';

console.log('browser-authenticated tests: start');

const RESPAN = 'https://platform.respan.ai/';
const RESPAN_PAGE = 'https://platform.respan.ai/projects/demo';

// --- bridge config: only safe local addresses
{
  const d = getRespanBridgeConfig({});
  assert.equal(d.ok, true);
  assert.equal(d.configured, false);
  assert.match(d.url, /^http:\/\/127\.0\.0\.1:18791$/);
  const good = getRespanBridgeConfig({ configUrl: 'http://localhost:19999/' });
  assert.equal(good.ok, true);
  assert.equal(good.url, 'http://localhost:19999');
  const bad = getRespanBridgeConfig({ configUrl: 'https://evil.example/bridge' });
  assert.equal(bad.ok, false);
  assert.equal(bad.configured, true);
  assert.equal(bad.url, null);
  console.log('bridge config: passed');
}

// --- sanitizer returns only visible page fields, never credentials
{
  const snap = sanitizeBridgeSnapshot({
    title: 'Respan Project',
    url: RESPAN_PAGE,
    text: 'Visible dashboard text',
    elements: [
      { role: 'heading', name: 'Projects', text: 'Projects', tag: 'h1', visible: true },
      { role: 'link', name: 'Settings', href: '/settings', text: 'Settings' },
    ],
    cookies: 'secret=1',
    sessionToken: 'tok',
    password: 'pw',
  }, RESPAN_PAGE);
  assert.equal(snap.ok, true);
  assert.equal(snap.title, 'Respan Project');
  assert.equal(snap.url, RESPAN_PAGE);
  assert.match(snap.text, /Visible dashboard text/);
  assert.equal(snap.elements.length, 2);
  assert.equal(snap.elements[0].role, 'heading');
  assert.equal(snap.elements[1].href, '/settings');
  const raw = JSON.stringify(snap);
  assert.doesNotMatch(raw, /secret=1|sessionToken|\"password\"|tok/);
  console.log('snapshot sanitization: passed');
}

function withBridgeServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          const out = handler({ method: req.method, url: req.url, body: parsed, headers: req.headers });
          res.writeHead(out.status || 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.json || {}));
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
    server.on('error', reject);
  });
}

// --- connected local bridge: status + authenticated read of visible Respan content
{
  const srv = await withBridgeServer(({ url, body }) => {
    if (url === '/status') return { json: { ok: true, ready: true, platform: 'respan' } };
    if (url === '/read') {
      assert.equal(body.platform, 'respan');
      assert.equal(isRespanPlatformUrl(body.url), true);
      return { json: { ok: true, page: {
        title: 'Respan — Project demo',
        url: body.url,
        text: 'Visible authenticated project details. Metrics and traces list.',
        elements: [{ role: 'heading', name: 'Project demo', text: 'Project demo' }, { role: 'table', name: 'Traces', text: 'Recent traces' }],
      }}};
    }
    return { status: 404, json: { ok: false, error: 'not found' } };
  });
  try {
    const env = { ROAMIES_RESPAN_BROWSER_BRIDGE: srv.url };
    const st = await respanBridgeStatus({ configUrl: srv.url });
    assert.equal(st.available, true, 'bridge reported available');
    assert.equal(st.bridgeUrl, srv.url);

    const r = await readRespanAuthenticatedPage(RESPAN_PAGE, { configUrl: srv.url });
    assert.equal(r.ok, true);
    assert.equal(r.authenticated, true);
    assert.equal(r.platform, 'respan');
    assert.match(r.title, /Project demo/);
    assert.match(r.text, /Visible authenticated project details/);
    assert.equal(r.elements.length, 2);
    assert.equal(r.elements[1].role, 'table');
    assert.match(String(r.note), /User consent required/i);
    assert.match(String(r.note), /no passwords, cookies, or session tokens/i);
    assert.doesNotMatch(JSON.stringify(r), /api token/i);
    console.log('authenticated bridge read: passed');
  } finally {
    await srv.close();
  }
}

// --- unavailable bridge: clear failure, no false success
{
  const env = { ROAMIES_RESPAN_BROWSER_BRIDGE: 'http://127.0.0.1:1' };
  const st = await respanBridgeStatus({ configUrl: 'http://127.0.0.1:1' });
  assert.equal(st.available, false);
  assert.match(String(st.reason || ''), /cannot reach|unavailable|not/i);
  const r = await readRespanAuthenticatedPage(RESPAN, { configUrl: 'http://127.0.0.1:1' });
  assert.equal(r.ok, false);
  assert.equal(r.platform, 'respan');
  assert.match(String(r.error || ''), /bridge|unavailable/i);
  assert.match(String(r.note || ''), /no credentials\/cookies\/session tokens/i);
  assert.doesNotMatch(String(r.note || '') + String(r.error || ''), /success/i);
  console.log('unavailable bridge: passed');
}

// --- Respan-only scope and preflight/permission integration
{
  const preBad = agentCorePreflight({ toolName: 'browser_read_respan_authenticated', args: { url: 'https://example.com/' } });
  assert.ok(preBad && preBad.ok === false, 'non-Respan URL rejected at preflight');
  const preOk = agentCorePreflight({ toolName: 'browser_read_respan_authenticated', args: { url: RESPAN_PAGE } });
  assert.equal(preOk, null, 'Respan URL passes preflight');

  const { tools } = createTools({ allowActions: false, ui: () => {}, ask: async () => false, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
  const channel = createApprovalChannel({ send: () => {}, ttlMs: 60000, logger: () => {} });
  const rt = createAgentCoreRuntime({ tools, approvalChannel: channel, grantedLevel: 'observe', requireApproval: [], env: {} });
  const statusRoute = rt.core.router.route('browser_respan_bridge_status', {}, { phase: 'initial' });
  assert.equal(statusRoute.allowed, true);
  assert.equal(statusRoute.requiresApproval, false);
  const readRoute = rt.core.router.route('browser_read_respan_authenticated', { url: RESPAN_PAGE }, { phase: 'initial' });
  assert.equal(readRoute.allowed, true, 'allowed subject to approval');
  assert.equal(readRoute.requiresApproval, true, 'sharing page content requires explicit user consent/approval');
  const nav = rt.core.router.route('browser_navigate', { action: 'open', url: RESPAN_PAGE }, { phase: 'initial' });
  assert.equal(nav.allowed, true);

  const other = await tools.find(t => t.name === 'browser_read_respan_authenticated').execute({ url: 'https://example.com/' }).then(() => null, (e) => e);
  assert.ok(other instanceof Error);
  assert.match(String(other.message), /Respan/i);
  console.log('scope/approval integration: passed');
}

// --- activity labels
{
  assert.deepEqual(describe('browser_respan_bridge_status', {}, 'en'), ['Checking Respan browser bridge', 'Checked browser bridge']);
  assert.ok(describe('browser_read_respan_authenticated', { url: RESPAN_PAGE }, 'en')[0].includes('Reading Respan'));
  console.log('activity labels: passed');
}

console.log('browser-authenticated tests: passed');
