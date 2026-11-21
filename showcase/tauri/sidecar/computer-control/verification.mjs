// Desktop verification: every condition is checked for real. A condition the service cannot check
// fails closed with a reason; nothing reports ok just because it was asked (the old always-ok stub
// success path is gone).
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 5000, maxBuffer: 2 << 20, ...opts }, (err, stdout, stderr) => {
    resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: err ? String(err.message || err) : '' });
  });
});

function matches(value, expected) {
  if (expected instanceof RegExp) return expected.test(String(value));
  return String(value).includes(String(expected));
}

async function clipboardText(ctx) {
  if (typeof ctx.readClipboard === 'function') return ctx.readClipboard();
  for (const [cmd, args] of [['wl-paste', []], ['xclip', ['-o', '-selection', 'clipboard']]]) {
    const r = await run(cmd, args);
    if (r.ok) return r.stdout;
  }
  throw new Error('No clipboard reader is available (install wl-clipboard or xclip).');
}

async function visibleText(ctx, target) {
  if (!ctx.atspi || typeof ctx.atspi.findElements !== 'function') throw new Error('AT-SPI is unavailable, so on-screen text cannot be read.');
  const els = await ctx.atspi.findElements({ applicationName: target || undefined });
  const parts = [];
  for (const el of els) {
    if (el.name) parts.push(el.name);
    if (el.description) parts.push(el.description);
    if (el.value) parts.push(el.value);
  }
  return parts.join('\n');
}

async function captureHash(ctx) {
  if (typeof ctx.capture !== 'function') throw new Error('No screenshot source is connected, so image change cannot be checked.');
  const shot = await ctx.capture();
  const data = Buffer.isBuffer(shot) ? shot : shot?.buffer ? Buffer.from(shot.buffer) : shot?.data ? Buffer.from(shot.data) : null;
  if (!data) throw new Error('The screenshot source returned no image bytes.');
  return createHash('sha256').update(data).digest('hex');
}

class DesktopVerificationService {
  constructor(ctx = {}) { this.ctx = ctx || {}; }

  async _check(cond) {
    const ctx = this.ctx;
    switch (cond.type) {
      case 'file_exists': {
        await fs.access(cond.target);
        return { ok: true, evidence: { path: cond.target } };
      }
      case 'file_contains': {
        const text = await fs.readFile(cond.target, 'utf8');
        const hit = matches(text, cond.expected);
        return hit ? { ok: true, evidence: { path: cond.target } } : { ok: false, error: `content not found in ${cond.target}` };
      }
      case 'window_focused': {
        if (!ctx.atspi) return { ok: false, error: 'AT-SPI is unavailable, so window focus cannot be checked.' };
        const windows = await ctx.atspi.getWindowList();
        const needle = String(cond.target ?? '').toLowerCase();
        const front = windows.find((w) => (w.states || []).some((s) => s === 'STATE_ACTIVE' || s === 'STATE_FOCUSED'));
        if (!front) return { ok: false, error: 'No window reports focus.' };
        const label = `${front.title || ''} ${front.appName || ''}`.toLowerCase();
        return label.includes(needle) ? { ok: true, evidence: { window: front.title, app: front.appName } } : { ok: false, error: `focused window is "${front.title || front.appName}", not ${cond.target}` };
      }
      case 'window_title': {
        if (!ctx.atspi) return { ok: false, error: 'AT-SPI is unavailable, so window titles cannot be checked.' };
        const windows = await ctx.atspi.getWindowList();
        const w = windows.find((x) => matches(`${x.title || ''} ${x.appName || ''}`, cond.expected));
        return w ? { ok: true, evidence: { window: w.title, app: w.appName } } : { ok: false, error: `no window matches ${cond.expected}` };
      }
      case 'element_present': {
        if (!ctx.atspi) return { ok: false, error: 'AT-SPI is unavailable, so elements cannot be checked.' };
        const criteria = cond.criteria || { name: cond.target };
        const els = await ctx.atspi.findElements(criteria);
        return (els && els.length) ? { ok: true, evidence: { element: els[0] } } : { ok: false, error: `element not found: ${JSON.stringify(criteria)}` };
      }
      case 'text_present': {
        // `target` is the text to look for; `app`/`applicationName` optionally narrows the search.
        const expected = cond.expected ?? cond.target;
        const app = cond.app ?? cond.applicationName;
        try {
          const text = await visibleText(ctx, app);
          if (matches(text, expected)) return { ok: true, evidence: { how: 'accessibility' } };
        } catch (e) {
          if (!ctx.capture || !ctx.ocr) return { ok: false, error: String(e?.message || e) };
        }
        if (ctx.capture && ctx.ocr) {
          const shot = await ctx.capture();
          const file = shot?.file || shot?.path;
          if (!file) return { ok: false, error: 'The capture returned no file for OCR.' };
          const res = await ctx.ocr(file);
          const text = res?.text ?? res ?? '';
          if (matches(text, expected)) return { ok: true, evidence: { how: 'ocr' } };
          return { ok: false, error: `text not present (checked accessibility and OCR): ${expected}` };
        }
        return { ok: false, error: `text not present: ${expected}` };
      }
      case 'clipboard_equals': {
        const text = await clipboardText(ctx);
        const expected = cond.expected ?? cond.target;
        return String(text) === String(expected) ? { ok: true, evidence: { clipboard: text } } : { ok: false, error: `clipboard is "${String(text).slice(0, 80)}", not ${expected}` };
      }
      case 'image_changed': {
        const hash = await captureHash(ctx);
        const baseline = cond.baseline ?? cond.baselineHash;
        if (!baseline) return { ok: false, error: 'image_changed needs a baseline hash; none was given.', evidence: { hash } };
        return hash !== baseline ? { ok: true, evidence: { hash, baseline } } : { ok: false, error: 'the image did not change', evidence: { hash } };
      }
      case 'command_succeeds': {
        if (typeof ctx.runCommand !== 'function') return { ok: false, error: 'command_succeeds needs a runCommand function; refusing to run an unchecked command.' };
        const r = await ctx.runCommand(cond.target, cond.args || []);
        return r?.ok ? { ok: true, evidence: { stdout: r.stdout } } : { ok: false, error: `command failed: ${r?.error || r?.stderr || 'non-zero exit'}` };
      }
      case 'url_matches': {
        if (typeof ctx.getUrl !== 'function') return { ok: false, error: 'url_matches needs a browser page; none is connected.' };
        const url = await ctx.getUrl();
        return matches(url, cond.expected) ? { ok: true, evidence: { url } } : { ok: false, error: `url is ${url}, not ${cond.expected}` };
      }
      case 'custom': {
        if (typeof ctx.custom !== 'function') return { ok: false, error: 'custom conditions need a custom function; none was given.' };
        const r = await ctx.custom(cond);
        return r === true ? { ok: true } : { ok: false, error: typeof r === 'string' ? r : 'the custom condition failed' };
      }
      default:
        return { ok: false, error: `unknown condition type: ${cond.type}` };
    }
  }

  async verify(conditions = []) {
    const results = [];
    for (const cond of conditions) {
      const t0 = Date.now();
      try {
        const r = await this._check(cond);
        results.push({ ...r, condition: cond, durationMs: Date.now() - t0 });
      } catch (e) {
        results.push({ ok: false, condition: cond, error: String(e?.message || e), durationMs: Date.now() - t0 });
      }
    }
    return results;
  }

  async verifyAll(conditions = []) {
    return (await this.verify(conditions)).every((r) => r.ok);
  }

  async executeRecovery(condition, recovery, action) {
    const retries = recovery?.maxRetries ?? 1;
    for (let i = 0; i <= retries; i++) {
      try { await action(); return true; } catch { if (recovery?.backoffMs) await new Promise((r) => setTimeout(r, recovery.backoffMs)); }
    }
    return false;
  }
}

export function createDesktopVerification(ctx) { return new DesktopVerificationService(ctx); }
export { DesktopVerificationService };
