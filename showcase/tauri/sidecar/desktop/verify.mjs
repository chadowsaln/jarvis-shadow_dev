import fs from 'node:fs/promises';

export function createVerify(ctx = {}) {
  const c = ctx || {};
  async function check(cond) {
    try {
      switch (cond.type) {
        case 'file_exists': {
          await fs.access(cond.target);
          return { ok: true };
        }
        case 'file_contains': {
          const buf = await fs.readFile(cond.target);
          const text = buf.toString('utf8');
          const expected = cond.expected;
          const hit = expected instanceof RegExp ? expected.test(text) : String(text).includes(String(expected));
          return hit ? { ok: true } : { ok: false, error: `content not found in ${cond.target}` };
        }
        case 'window_focused': {
          if (typeof c.isWindowFocused !== 'function') return { ok: false, error: 'backend missing: isWindowFocused' };
          const ok = await c.isWindowFocused(cond.target);
          return ok ? { ok: true } : { ok: false, error: `window not focused: ${cond.target}` };
        }
        case 'window_title': {
          if (typeof c.getWindow !== 'function') return { ok: false, error: 'backend missing: getWindow' };
          const w = await c.getWindow(cond.target);
          const title = w?.title ?? w?.name ?? '';
          const expected = cond.expected;
          const hit = expected instanceof RegExp ? expected.test(title) : String(title).includes(String(expected));
          return hit ? { ok: true } : { ok: false, error: `title mismatch: got "${title}"` };
        }
        case 'element_present': {
          if (typeof c.findElements !== 'function') return { ok: false, error: 'backend missing: findElements' };
          const els = await c.findElements(cond.criteria || { name: cond.target });
          return (Array.isArray(els) && els.length > 0) ? { ok: true } : { ok: false, error: `element not found: ${cond.target}` };
        }
        case 'text_present': {
          if (typeof c.getVisibleText !== 'function') return { ok: false, error: 'backend missing: getVisibleText' };
          const text = await c.getVisibleText(cond.target);
          const expected = cond.expected ?? cond.target;
          const hit = expected instanceof RegExp ? expected.test(String(text)) : String(text).includes(String(expected));
          return hit ? { ok: true } : { ok: false, error: `text not present: ${expected}` };
        }
        case 'clipboard_equals': {
          if (typeof c.readClipboard !== 'function') return { ok: false, error: 'backend missing: readClipboard' };
          const val = await c.readClipboard();
          const expected = cond.expected ?? cond.target;
          return String(val) === String(expected) ? { ok: true } : { ok: false, error: `clipboard mismatch: got "${val}"` };
        }
        case 'image_changed': {
          if (typeof c.captureHash !== 'function') return { ok: false, error: 'backend missing: captureHash' };
          const hash = await c.captureHash(cond.target);
          const baseline = cond.baseline;
          if (baseline == null) return { ok: true, baseline: hash };
          return hash !== baseline ? { ok: true } : { ok: false, error: 'image unchanged' };
        }
        default:
          return { ok: false, error: `unknown condition type: ${cond.type}` };
      }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }
  return {
    async verify(conditions = []) {
      const results = [];
      for (const cond of conditions) {
        const t0 = Date.now();
        const r = await check(cond);
        results.push({ ...r, condition: cond, durationMs: Date.now() - t0 });
      }
      return results;
    },
    async verifyAll(conditions = []) {
      const results = await this.verify(conditions);
      return results.every(r => r.ok);
    },
  };
}
