// Desktop input adapter — adapters only, no policy, no approvals.
// Wraps a backend object that implements the raw primitives. The backend is
// injected so tests can pass a recording fake.

export function createInput(backend) {
  const b = backend || {};
  const call = async (name, ...args) => {
    if (typeof b[name] !== 'function') throw new Error(`input backend does not implement ${name}`);
    return b[name](...args);
  };
  return {
    async move(x, y, opts = {}) {
      return call('move', x, y, opts);
    },
    async relative(dx, dy, opts = {}) {
      if (typeof b.relative === 'function') return b.relative(dx, dy, opts);
      // Fallback: backend reports current position? We can't; require backend support.
      throw new Error('input backend does not implement relative');
    },
    async click(x, y, opts = {}) {
      return call('click', x, y, opts);
    },
    async doubleClick(x, y, opts = {}) {
      if (typeof b.doubleClick === 'function') return b.doubleClick(x, y, opts);
      await call('click', x, y, opts);
      await new Promise(r => setTimeout(r, 60));
      return call('click', x, y, opts);
    },
    async down(button = 'left') { return call('down', button); },
    async up(button = 'left') { return call('up', button); },
    async drag(fromX, fromY, toX, toY, opts = {}) {
      if (typeof b.drag === 'function') return b.drag(fromX, fromY, toX, toY, opts);
      await call('move', fromX, fromY);
      await call('down', 'left');
      await call('move', toX, toY, { durationMs: opts.durationMs });
      return call('up', 'left');
    },
    async scroll(x, y, dx = 0, dy = 0) {
      return call('scroll', x, y, dx, dy);
    },
    async type(text, opts = {}) {
      return call('type', text, opts);
    },
    async key(key, modifiers = []) {
      if (modifiers && modifiers.length) return call('hotkey', modifiers, key);
      return call('press', key);
    },
    async hotkey(modifiers = [], key) {
      return call('hotkey', modifiers, key);
    },
  };
}
