export function createApps(backend) {
  const b = backend || {};
  const call = async (name, ...args) => {
    if (typeof b[name] !== 'function') throw new Error(`apps backend does not implement ${name}`);
    return b[name](...args);
  };
  return {
    async list() { return call('list'); },
    async find(query) { return call('find', query); },
    async launch(name) { return call('launch', name); },
    async quit(name, opts = {}) { return call('quit', name, opts); },
    async front() { return call('front'); },
  };
}
