// Browser Intelligence (Batch 9): discover installed/running browsers and open/read/search/navigate web content.
// Includes integrated support for the Respan platform (https://platform.respan.ai/): accessibility/open/navigate/read
// of visible content via safe browser primitives. Existing browser login sessions are preserved by opening in the
// user's default browser; this module never extracts passwords, cookies, or session tokens and never bypasses
// login/CAPTCHA. Sidecar fetch-based reads are unauthenticated and must not access or modify account state.
// All navigation/reading goes through existing safe primitives (open/x-www-browser/xdg-open, web_fetch, web_search).
import os from 'node:os';

export const BROWSER_ACTIONS = ['open', 'back', 'forward', 'reload'];

// A Linux desktop entry counts as a browser if its categories/keywords/exec/name suggest one.
export function isLikelyBrowserApp(app) {
  if (!app) return false;
  const cats = new Set((app.categories || []).map((c) => String(c).toLowerCase()));
  if (cats.has('webbrowser')) return true;
  const kw = (app.keywords || []).map((k) => String(k).toLowerCase());
  if (kw.some((k) => /\b(browser|web|internet)\b/.test(k))) return true;
  const text = `${app.name || ''} ${app.exec || ''} ${app.tryExec || ''} ${app.id || ''}`.toLowerCase();
  return /\b(firefox|chromium|chrome|brave|vivaldi|opera|epiphany|konqueror|falkon|qutebrowser|midori|librewolf|floorp|zen|waterfox|edge|tor-browser)\b/.test(text);
}

/** Installed browsers from parsed desktop entries, deduped by id, stable order. */
export function filterBrowserApps(apps = []) {
  const out = []; const seen = new Set();
  for (const a of apps) {
    if (!a || !a.id || seen.has(a.id)) continue;
    if (!isLikelyBrowserApp(a)) continue;
    seen.add(a.id);
    out.push({ id: a.id, name: a.name, exec: a.exec || null, source: a.source || null });
  }
  out.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  return out;
}

/** Browser discovery: installed (desktop entries) and currently running (matched by /proc on Linux). */
export async function browserDiscover({ platform = process.platform, desktopApps, runningApps } = {}) {
  let installed = [];
  let running = [];
  if (platform === 'linux' && typeof desktopApps === 'function') {
    try {
      const all = await desktopApps();
      installed = filterBrowserApps(all);
      if (typeof runningApps === 'function') {
        try {
          const run = await runningApps(all);
          const byId = new Set();
          running = run.filter((r) => r?.app && isLikelyBrowserApp(r.app)).reduce((acc, r) => {
            if (byId.has(r.app.id)) return acc; byId.add(r.app.id);
            acc.push({ id: r.app.id, name: r.app.name, pids: r.pids || [] });
            return acc;
          }, []);
        } catch { running = []; }
      }
    } catch { installed = []; running = []; }
  } else {
    installed = [];
    running = [];
  }
  return {
    platform,
    defaultBrowser: { available: true, note: platform === 'linux' ? 'opens via x-www-browser/xdg-open/open' : 'opens via the system default browser' },
    installed,
    running,
    note: installed.length || running.length ? null : (platform === 'linux'
      ? 'No browser desktop entries detected; opening links in the default browser is still available.'
      : 'Installed/running browser inventory is not enumerated on this platform; default-browser open is available.'),
  };
}

/** Open a user-specified URL in the system default browser (no custom browser control). */
export async function browserOpenUrl(url, { platform = process.platform, execFile } = {}) {
  if (typeof execFile !== 'function') throw new Error('execFile unavailable');
  if (platform === 'darwin') { await execFile('open', [url]); return { opened: true, with: 'open' }; }
  if (platform === 'win32') { await execFile('cmd', ['/c', 'start', '', url]); return { opened: true, with: 'start' }; }
  try { await execFile('x-www-browser', [url]); return { opened: true, with: 'x-www-browser' }; }
  catch (e) {
    try { await execFile('xdg-open', [url]); return { opened: true, with: 'xdg-open' }; }
    catch (e2) { throw new Error(`could not open browser: ${e2?.message || e?.message || 'no handler'}`); }
  }
}

// Best-effort visible-language hint from text for AR/EN reporting (lightweight, no external deps).
export function detectPageLang(text) {
  const s = String(text || '');
  const ar = (s.match(/[\u0600-\u06FF]/g) || []).length;
  const en = (s.match(/[A-Za-z]/g) || []).length;
  if (!ar && !en) return 'unknown';
  if (ar && en) {
    if (ar / en >= 0.35 && en / ar >= 0.35) return 'mixed';
  }
  if (ar >= en * 1.2) return 'ar';
  if (en >= ar * 1.2) return 'en';
  if (ar && en) return 'mixed';
  return ar ? 'ar' : 'en';
}

// --- Compatibility exports (used by tools.mjs / earlier integrations) ---

// --- Authenticated Respan reading via optional local browser bridge (Batch 9.1) ---
// A user-installed browser extension/companion may expose a SAFE local interface that returns only visible page
// content (title/url/text/elements) from the user's current authenticated browser session. Little Boy never receives
// or extracts passwords, cookies, or session tokens; the bridge must not send them. This module only talks to an
// explicitly configured local bridge and only for Respan platform URLs. Consent is required before sharing page
// content (enforced at tool/permission level via approval).

export const RESPAN_BRIDGE_ENV = 'ROAMIES_RESPAN_BROWSER_BRIDGE';
export const RESPAN_BRIDGE_DEFAULT = 'http://127.0.0.1:18791';

function normalizeBridgeUrl(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  const host = (u.hostname || '').toLowerCase();
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!local) return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // strip path/query/fragment; bridge defines its own endpoint paths
  u.pathname = '/';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

export function getRespanBridgeConfig(env = process.env) {
  const configuredRaw = env?.[RESPAN_BRIDGE_ENV];
  const explicit = configuredRaw != null && String(configuredRaw).trim() !== '';
  const normalized = normalizeBridgeUrl(explicit ? configuredRaw : RESPAN_BRIDGE_DEFAULT);
  if (explicit && !normalized) {
    return { ok: false, configured: true, url: null, reason: 'Configured browser bridge URL is invalid or not a local address. Use a localhost/127.0.0.1 URL.' };
  }
  return { ok: true, configured: explicit, url: normalized, reason: null };
}

function pickVisibleText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(pickVisibleText).filter(Boolean).join('\n');
  if (typeof v === 'object') return String(v.text ?? v.value ?? v.label ?? v.name ?? v.title ?? '');
  return String(v);
}

export function sanitizeBridgeSnapshot(payload = {}, requestedUrl = '') {
  const title = typeof payload.title === 'string' ? payload.title : '';
  const url = typeof payload.url === 'string' ? payload.url : (typeof payload.location === 'string' ? payload.location : requestedUrl);
  const text = String(payload.text ?? payload.visibleText ?? payload.content ?? payload.bodyText ?? '').slice(0, 20000);
  const rawEls = Array.isArray(payload.elements) ? payload.elements : (Array.isArray(payload.visibleElements) ? payload.visibleElements : []);
  const elements = rawEls.slice(0, 200).map((el) => {
    if (el == null) return null;
    if (typeof el === 'string') return { text: el.slice(0, 500) };
    const o = {
      role: typeof el.role === 'string' ? el.role.slice(0, 80) : undefined,
      name: typeof el.name === 'string' ? el.name.slice(0, 300) : undefined,
      text: pickVisibleText(el.text ?? el.label ?? el.value).slice(0, 1000),
      tag: typeof el.tag === 'string' ? el.tag.slice(0, 40) : undefined,
      href: typeof el.href === 'string' ? el.href.slice(0, 500) : undefined,
      visible: el.visible === false ? false : true,
    };
    Object.keys(o).forEach((k) => (o[k] == null || o[k] === '') && delete o[k]);
    return Object.keys(o).length ? o : null;
  }).filter(Boolean);
  return { ok: true, title, url: String(url || requestedUrl || ''), text, elements, lang: detectPageLang(`${title} ${text}`) };
}

async function fetchBridgeJson(baseUrl, pathName, body, { fetchFn = globalThis.fetch, timeoutMs = 4000 } = {}) {
  if (typeof fetchFn !== 'function') throw new Error('fetch unavailable');
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs) : null;
  try {
    const r = await fetchFn(`${baseUrl}${pathName}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(body || {}),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    const ct = String(r?.headers?.get?.('content-type') || '');
    let data = null;
    if (ct.includes('application/json')) data = await r.json();
    else {
      const txt = await r.text();
      try { data = JSON.parse(txt); } catch { data = { ok: false, error: txt || `HTTP ${r?.status}` }; }
    }
    return { status: r?.status ?? 0, ok: !!r?.ok, data };
  } finally {
    if (t) clearTimeout(t);
  }
}

export async function respanBridgeStatus({ env = process.env, fetchFn = globalThis.fetch } = {}) {
  const cfg = getRespanBridgeConfig(env);
  if (!cfg.ok) return { available: false, configured: cfg.configured, bridgeUrl: null, reason: cfg.reason };
  try {
    const r = await fetchBridgeJson(cfg.url, '/status', { platform: 'respan' }, { fetchFn, timeoutMs: 2500 });
    if (r.ok && r.data && (r.data.ok === true || r.data.ready === true || r.data.connected === true || r.data.status === 'ok')) {
      return { available: true, configured: cfg.configured, bridgeUrl: cfg.url, detail: r.data };
    }
    // A reachable local endpoint that responds means bridge interface exists but may not be ready/connected.
    if (r.status) return { available: false, configured: cfg.configured, bridgeUrl: cfg.url, reason: String(r.data?.reason || r.data?.error || `Bridge responded (HTTP ${r.status}) but is not ready.`) };
  } catch (e) {
    const isConfigured = cfg.configured;
    const baseMsg = isConfigured
      ? `Cannot reach configured local browser bridge at ${cfg.url}: ${String(e?.message || e)}`
      : 'No authenticated browser bridge detected at the default address (http://127.0.0.1:18791).';
    const hint = isConfigured
      ? 'Ensure the bridge extension/app is running and accessible at the configured URL.'
      : 'To read authenticated Respan content, install a browser extension that exposes a local HTTP bridge with /status and /read endpoints (see Respan platform documentation), then set ROAMIES_RESPAN_BROWSER_BRIDGE if it uses a different address.';
    return { available: false, configured: cfg.configured, bridgeUrl: cfg.url, reason: `${baseMsg} ${hint}` };
  }
  return { available: false, configured: cfg.configured, bridgeUrl: cfg.url, reason: 'Authenticated browser bridge is not available.' };
}

export async function readRespanAuthenticatedPage(url, { env = process.env, fetchFn = globalThis.fetch } = {}) {
  if (!isRespanPlatformUrl(url)) {
    return { ok: false, url: String(url || ''), error: 'Authenticated browser reading via this bridge is supported only for the Respan platform (https://platform.respan.ai/).' };
  }
  const cfg = getRespanBridgeConfig(env);
  if (!cfg.ok) return { ok: false, url: String(url || ''), error: cfg.reason, bridge: { available: false } };
  const consentNote = 'User consent required and assumed granted for this approved read: only visible page content (title/url/text/elements) may be shared with Little Boy; no passwords, cookies, or session tokens are extracted or sent.';
  try {
    const r = await fetchBridgeJson(cfg.url, '/read', { url: String(url), platform: 'respan', scope: 'visible-content' }, { fetchFn, timeoutMs: 8000 });
    if (!r.ok || !r.data || r.data.ok === false) {
      const reason = String(r.data?.error || r.data?.reason || `Bridge read failed (HTTP ${r.status || 'error'}).`);
      return { ok: false, url: String(url || ''), platform: 'respan', bridge: { available: !!r.status, bridgeUrl: cfg.url }, error: reason, note: 'Authenticated Respan reading requires a connected local browser bridge/extension with access to the user\'s signed-in browser session. Login/CAPTCHA are not bypassed and no credentials/cookies/session tokens are accessed.' };
    }
    const snap = sanitizeBridgeSnapshot(r.data.page || r.data.snapshot || r.data, url);
    const wall = detectAuthOrCaptchaWall(snap.text, snap.title);
    const noteParts = [consentNote, 'Read via local authenticated browser bridge (visible content only) for Respan platform.'];
    if (wall) noteParts.push(`${wall.reason} Not bypassed; if visible content is limited, complete login/CAPTCHA in your browser and retry with consent.`);
    return { ok: true, platform: 'respan', authenticated: true, url: snap.url || String(url), title: snap.title, text: snap.text, elements: snap.elements, lang: snap.lang, authWall: wall ? wall.kind : null, bridge: { available: true, bridgeUrl: cfg.url }, note: noteParts.join(' ') };
  } catch (e) {
    const isConfigured = cfg.configured;
    const baseMsg = isConfigured
      ? `Cannot reach configured local browser bridge at ${cfg.url}: ${String(e?.message || e)}`
      : 'No authenticated browser bridge detected at the default address (http://127.0.0.1:18791).';
    const hint = isConfigured
      ? 'Ensure the bridge extension/app is running and accessible at the configured URL.'
      : 'To read authenticated Respan content, install a browser extension that exposes a local HTTP bridge with /status and /read endpoints (see Respan platform documentation), then set ROAMIES_RESPAN_BROWSER_BRIDGE if it uses a different address.';
    return { ok: false, url: String(url || ''), platform: 'respan', bridge: { available: false, bridgeUrl: cfg.url }, error: `${baseMsg} ${hint}`, note: 'No credentials/cookies/session tokens are extracted. Open the page in your browser to use your signed-in session, or use unauthenticated browser_read_page for visible public content.' };
  }
}

export async function getDefaultBrowserInfo() {
  return { available: true, note: 'System default browser (xdg-open/open/start).' };
}

export function browserStatusText(info = {}) {
  const inst = (info.installed || []).map((b) => b.name || b.id).filter(Boolean);
  const run = (info.running || []).map((b) => b.name || b.id).filter(Boolean);
  const parts = [];
  parts.push(`Default browser: available.`);
  parts.push(inst.length ? `Installed: ${inst.join(', ')}.` : 'Installed: none detected.');
  parts.push(run.length ? `Running: ${run.join(', ')}.` : 'Running: none detected.');
  if (info.note) parts.push(String(info.note));
  return parts.join(' ');
}

export function summarizeSearchResults(results = [], { limit = 5 } = {}) {
  return (results || []).slice(0, limit).map((r, i) => ({
    i: i + 1,
    title: r?.title || r?.name || '',
    url: r?.url || r?.link || '',
    snippet: r?.snippet || r?.description || r?.content || '',
  }));
}


// --- Respan platform support (integrated, observe-only) ---
export const RESPAN_PLATFORM_URL = 'https://platform.respan.ai/';

export function isRespanPlatformUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'https:' && u.hostname.toLowerCase() === 'platform.respan.ai';
  } catch { return false; }
}

/** Heuristic: does fetched text look like a login/captcha/auth wall? (no bypass, report only). */
export function detectAuthOrCaptchaWall(text = '', title = '') {
  const s = `${String(title || '')}
${String(text || '')}`.slice(0, 12000).toLowerCase();
  if (!s.trim()) return null;
  const captcha = /(captcha|recaptcha|hcaptcha|cloudflare|are you human|verify you are human|challenge-platform|cf-turnstile)/i.test(s);
  const login = /(sign\s*-?\s*in|log\s*-?\s*in|continue with|sso|single sign-?on|authentication required|unauthorized|session expired|please log in|please sign in|تسجيل الدخول|سجّل الدخول)/i.test(s);
  if (captcha) return { kind: 'captcha', reason: 'CAPTCHA or human-verification challenge detected in visible content.' };
  if (login) return { kind: 'login', reason: 'Login/authentication wall detected in visible content.' };
  return null;
}

export function respanReadNote(url, { wall = null } = {}) {
  if (!isRespanPlatformUrl(url)) return null;
  const base = 'Respan platform (https://platform.respan.ai/): this fetch-based read is unauthenticated and does not use your browser session. Existing browser login sessions are preserved in your browser; no passwords, cookies, or session tokens are accessed or extracted.';
  if (wall?.kind === 'captcha') return `${base} A CAPTCHA/challenge was detected — it cannot be bypassed. Use browser_open to view/interact in your logged-in browser session (no account actions without explicit approval).`;
  if (wall?.kind === 'login') return `${base} A login/auth wall was detected — login is not bypassed. If you are already signed in in your browser, open the page with browser_open to view your session content there; I cannot read authenticated session content without browser session access.`;
  return `${base} If account-specific content is not visible here, open the page in your browser to use your existing signed-in session.`;
}

export async function fetchReadablePage(url, { fetchTool, offset = 0 } = {}) {
  if (!fetchTool || typeof fetchTool.execute !== 'function') throw new Error('fetch tool unavailable');
  const r = await fetchTool.execute({ url, offset });
  const text = String(r?.text || r?.markdown || '');
  const title = r?.title || '';
  const wall = detectAuthOrCaptchaWall(text, title);
  const respanNote = respanReadNote(r?.url || url, { wall });
  const noteParts = [];
  if (wall && !respanNote) noteParts.push(`${wall.reason} Content may require login/CAPTCHA; access is not bypassed.`);
  if (respanNote) noteParts.push(respanNote);
  return {
    ok: true,
    url: String(r?.url || url),
    title,
    text,
    lang: detectPageLang(`${title} ${text}`),
    truncated: !!r?.truncated,
    nextOffset: r?.nextOffset ?? null,
    authWall: wall ? wall.kind : null,
    note: noteParts.join(' ') || null,
  };
}
