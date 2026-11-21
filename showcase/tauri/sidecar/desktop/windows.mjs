export function createWindows(backend) {
  const b = backend || {};
  const call = async (name, ...args) => {
    if (typeof b[name] !== 'function') throw new Error(`windows backend does not implement ${name}`);
    return b[name](...args);
  };
  return {
    async list() { return call('list'); },
    async focus(target) { return call('focus', target); },
    async minimize(target) { return call('minimize', target); },
    async maximize(target) { return call('maximize', target); },
    async restore(target) { return call('restore', target); },
    async move(target, x, y) { return call('move', target, x, y); },
    async resize(target, w, h) { return call('resize', target, w, h); },
    async monitors() { return call('monitors'); },
  };
}
