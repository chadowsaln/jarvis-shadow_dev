// Batch 9: Browser Intelligence - discovery, safe open/read, navigation, search integration hooks, AR/EN support.
// Focused tests (no live browser UI, no network, no tokens). Run: npm test
import assert from 'node:assert/strict';
import { BROWSER_ACTIONS, RESPAN_PLATFORM_URL, browserDiscover, browserOpenUrl, browserStatusText, detectAuthOrCaptchaWall, detectPageLang, fetchReadablePage, filterBrowserApps, isLikelyBrowserApp, isRespanPlatformUrl, respanReadNote, summarizeSearchResults } from '../browser.mjs';
import { agentCorePreflight } from '../agentcore/preflight.mjs';
import { createAgentCoreRuntime } from '../agentcore/runtime.mjs';
import { createApprovalChannel } from '../agentcore/approval-channel.mjs';
import { createTools } from '../tools.mjs';
import { describe } from '../activity.mjs';

console.log('browser tests: start');

// --- discovery and classification
{
  const apps = [
    { id: 'firefox.desktop', name: 'Firefox', categories: ['Network', 'WebBrowser'], exec: 'firefox %u' },
    { id: 'org.gnome.Nautilus.desktop', name: 'Files', categories: ['System'], exec: 'nautilus' },
    { id: 'com.google.Chrome.desktop', name: 'Google Chrome', exec: '/usr/bin/google-chrome-stable %U' },
    { id: 'firefox.desktop', name: 'Firefox dup', categories: ['WebBrowser'] },
  ];
  assert.equal(isLikelyBrowserApp(apps[0]), true);
  assert.equal(isLikelyBrowserApp(apps[1]), false);
  assert.equal(isLikelyBrowserApp(apps[2]), true);
  const browsers = filterBrowserApps(apps);
  assert.equal(browsers.length, 2);
  assert.ok(browsers.some((b) => b.id === 'firefox.desktop'));
  assert.ok(browsers.some((b) => b.id === 'com.google.Chrome.desktop'));
  assert.equal(browserStatusText({ installed: browsers, running: [{ name: 'Firefox' }] }).includes('Firefox'), true);
  console.log('browser discovery/classification: passed');
}

// --- browserDiscover (linux path uses injected helpers, no /proc access required)
{
  const desktopApps = async () => [
    { id: 'firefox.desktop', name: 'Firefox', categories: ['WebBrowser'], exec: 'firefox' },
    { id: 'org.gnome.TextEditor.desktop', name: 'Text Editor', categories: ['Utility'] },
  ];
  const runningApps = async () => ([{ app: { id: 'firefox.desktop', name: 'Firefox', categories: ['WebBrowser'] }, pids: [123] }]);
  const info = await browserDiscover({ platform: 'linux', desktopApps, runningApps });
  assert.equal(info.platform, 'linux');
  assert.equal(info.installed.length, 1);
  assert.equal(info.installed[0].name, 'Firefox');
  assert.equal(info.running.length, 1);
  assert.equal(info.defaultBrowser.available, true);
  const other = await browserDiscover({ platform: 'darwin' });
  assert.equal(other.installed.length, 0);
  assert.equal(other.defaultBrowser.available, true);
  console.log('browserDiscover: passed');
}

// --- open in default browser (no network/UI), URL safety delegated
{
  const calls = [];
  const execFile = async (cmd, args) => { calls.push([cmd, args]); };
  const r1 = await browserOpenUrl('https://example.com', { platform: 'linux', execFile });
  assert.equal(r1.opened, true);
  assert.equal(calls[0][0], 'x-www-browser');
  assert.equal(calls[0][1][0], 'https://example.com');
  const calls2 = [];
  const r2 = await browserOpenUrl('https://example.com/مسار', { platform: 'darwin', execFile: async (c,a)=>calls2.push([c,a]) });
  assert.equal(r2.with, 'open');
  assert.ok(String(calls2[0][1][0]).includes('مسار'), 'Arabic URL preserved');
  let fellBack = false;
  const r3 = await browserOpenUrl('https://example.org', { platform: 'linux', execFile: async (cmd, args) => {
    if (cmd === 'x-www-browser') throw new Error('missing');
    fellBack = true; return [cmd,args];
  }});
  assert.equal(fellBack, true);
  assert.equal(r3.with, 'xdg-open');
  assert.deepEqual(BROWSER_ACTIONS, ['open', 'back', 'forward', 'reload']);
  console.log('browserOpenUrl: passed');
}

// --- language detection and result summarization (AR/EN support)
{
  assert.equal(detectPageLang('Hello world'), 'en');
  assert.equal(detectPageLang('مرحبا بالعالم'), 'ar');
  assert.equal(detectPageLang('Hello مرحبا world'), 'mixed');
  assert.equal(detectPageLang('12345 !!!'), 'unknown');
  const sum = summarizeSearchResults([{ title: 'مثال', url: 'https://example.com', snippet: 'Arabic result' }, { title: 'Ex', url: 'https://en.example' }], { limit: 1 });
  assert.equal(sum.length, 1);
  assert.equal(sum[0].title, 'مثال');
  console.log('language/summarization: passed');
}

// --- safety preflight: browser/web URL tools blocked for unsafe targets, allowed for public https
{
  const bad = agentCorePreflight({ toolName: 'browser_open', args: { url: 'http://127.0.0.1:8080/' } });
  assert.ok(bad && bad.ok === false, 'localhost/private URL blocked at preflight');
  const badRead = agentCorePreflight({ toolName: 'browser_read_page', args: { url: 'file:///etc/passwd' } });
  assert.ok(badRead && badRead.ok === false, 'file URL blocked');
  const badNav = agentCorePreflight({ toolName: 'browser_navigate', args: { action: 'open', url: 'http://10.0.0.5/' } });
  assert.ok(badNav && badNav.ok === false, 'private network URL blocked');
  const ok = agentCorePreflight({ toolName: 'browser_open', args: { url: 'https://example.com' } });
  assert.equal(ok, null);
  const okWeb = agentCorePreflight({ toolName: 'web_fetch', args: { url: 'https://example.com/page' } });
  assert.equal(okWeb, null);
  console.log('preflight safety: passed');
}

// --- tool exposure and permissions via Agent Core (observe, no approval, routed through core)
{
  const { tools } = createTools({ allowActions: false, ui: () => {}, ask: async () => false, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
  const channel = createApprovalChannel({ send: () => {}, ttlMs: 60000, logger: () => {} });
  const rt = createAgentCoreRuntime({ tools, approvalChannel: channel, grantedLevel: 'observe', requireApproval: [], env: {} });
  for (const n of ['browser_discover', 'browser_open', 'browser_read_page', 'browser_navigate']) {
    const t = rt.tools.find((x) => x.name === n);
    assert.ok(t, `${n} offered`);
    const r = rt.core.router.route(n, n === 'browser_discover' ? {} : (n === 'browser_navigate' ? { action: 'open', url: 'https://example.com' } : { url: 'https://example.com' }), { phase: 'initial' });
    assert.equal(r.allowed, true, `${n} allowed at observe`);
    assert.equal(r.requiresApproval, false, `${n} no approval`);
  }
  // web_search/web_fetch are observe-style but may not carry core permission metadata; if routed, must be safe.
  console.log('tool exposure/permissions: passed');
}

// --- activity labels
{
  assert.deepEqual(describe('browser_discover', {}), ['Checking browsers', 'Checked browsers']);
  assert.deepEqual(describe('browser_open', { url: 'https://example.com/path' }), ['Opening example.com', 'Opened example.com']);
  assert.deepEqual(describe('browser_read_page', { url: 'https://news.example.com' }), ['Reading news.example.com', 'Read news.example.com']);
  assert.deepEqual(describe('browser_navigate', { action: 'back' })[0], 'Navigating: back');
  assert.ok(describe('web_search', { query: 'Roamies بحث' })[0].includes('Searching the web'));
  console.log('activity labels: passed');
}

// --- Respan platform support (integrated): accessibility/open/navigate/read without credential access or bypass
{
  assert.equal(RESPAN_PLATFORM_URL, 'https://platform.respan.ai/');
  assert.equal(isRespanPlatformUrl('https://platform.respan.ai/'), true);
  assert.equal(isRespanPlatformUrl('https://platform.respan.ai/dashboard/projects'), true);
  assert.equal(isRespanPlatformUrl('http://platform.respan.ai/'), false);
  assert.equal(isRespanPlatformUrl('https://example.com/'), false);

  const { tools } = createTools({ allowActions: false, ui: () => {}, ask: async () => false, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
  const channel = createApprovalChannel({ send: () => {}, ttlMs: 60000, logger: () => {} });
  const rt = createAgentCoreRuntime({ tools, approvalChannel: channel, grantedLevel: 'observe', requireApproval: [], env: {} });
  for (const n of ['browser_open', 'browser_read_page']) {
    const r = rt.core.router.route(n, { url: 'https://platform.respan.ai/' }, { phase: 'initial' });
    assert.equal(r.allowed, true, `${n} allowed for Respan platform URL`);
    assert.equal(r.requiresApproval, false, `${n} observe/no approval for Respan`);
  }
  const nav = rt.core.router.route('browser_navigate', { action: 'open', url: 'https://platform.respan.ai/' }, { phase: 'initial' });
  assert.equal(nav.allowed, true);
  const pre = agentCorePreflight({ toolName: 'browser_open', args: { url: 'https://platform.respan.ai/' } });
  assert.equal(pre, null, 'Respan platform URL passes preflight safety checks');

  const loginWall = detectAuthOrCaptchaWall('Welcome. Please sign in to continue to Respan.', 'Sign in');
  assert.equal(loginWall?.kind, 'login');
  const captchaWall = detectAuthOrCaptchaWall('Verify you are human with CAPTCHA', 'Just a moment');
  assert.equal(captchaWall?.kind, 'captcha');
  const note = respanReadNote('https://platform.respan.ai/', { wall: loginWall });
  assert.match(note, /Respan platform/i);
  assert.match(note, /no passwords, cookies, or session tokens/i);
  assert.doesNotMatch(note, /api token/i);

  const loginFetch = { execute: async ({ url }) => ({ url, title: 'Sign in - Respan', text: 'Please sign in to continue. SSO available.', truncated: false, nextOffset: null }) };
  const rLogin = await fetchReadablePage('https://platform.respan.ai/', { fetchTool: loginFetch });
  assert.equal(rLogin.authWall, 'login');
  assert.match(String(rLogin.note), /login\/auth wall/i);
  assert.match(String(rLogin.note), /preserved in your browser/i);

  const okFetch = { execute: async ({ url }) => ({ url, title: 'Respan Platform', text: 'Public documentation and platform information.', truncated: false, nextOffset: null }) };
  const rOk = await fetchReadablePage('https://platform.respan.ai/', { fetchTool: okFetch });
  assert.equal(rOk.authWall, null);
  assert.match(String(rOk.note), /Respan platform/i);
  console.log('respan platform support: passed');
}

console.log('browser tests: passed');
