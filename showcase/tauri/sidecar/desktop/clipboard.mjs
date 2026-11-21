export function createClipboard(backend) {
  const b = backend || {};
  const call = async (name, ...args) => {
    if (typeof b[name] !== 'function') throw new Error(`clipboard backend does not implement ${name}`);
    return b[name](...args);
  };
  let saved = null;
  return {
    async read() { return call('read'); },
    async write(text) { return call('write', text); },
    async preserve() { saved = await call('read'); return saved; },
    async restore() { if (saved !== null) { await call('write', saved); const v = saved; saved = null; return v; } return null; },
    get saved() { return saved; },
  };
}
