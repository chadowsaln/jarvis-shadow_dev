import dbus from 'dbus-next';

const BUS_NAME = 'org.a11y.Bus';
const BUS_PATH = '/org/a11y/bus';
const BUS_IFACE = 'org.a11y.Bus';
const ACCESSIBLE_IFACE = 'org.a11y.atspi.Accessible';
const COMPONENT_IFACE = 'org.a11y.atspi.Component';
const ACTION_IFACE = 'org.a11y.atspi.Action';

async function getAtspiBusAddress() {
  const session = dbus.sessionBus();
  try {
    const obj = await session.getProxyObject(BUS_NAME, BUS_PATH);
    const iface = obj.getInterface(BUS_IFACE);
    const addr = await iface.GetAddress();
    return String(addr);
  } finally {
    try { session.disconnect(); } catch {}
  }
}

async function getAtspiBus() {
  const addr = await getAtspiBusAddress();
  return dbus.sessionBus({ busAddress: addr });
}

function variantValue(v) {
  if (v && typeof v === 'object' && 'value' in v) return v.value;
  return v;
}

class ATSPIDriver {
  constructor() {
    this.bus = null;
  }

  async connect() {
    if (this.bus) return this;
    try {
      this.bus = await getAtspiBus();
      return this;
    } catch (e) {
      this.bus = null;
      throw e;
    }
  }

  async disconnect() {
    if (this.bus) {
      try { this.bus.disconnect(); } catch {}
      this.bus = null;
    }
  }

  async _getAccessible(busName, path) {
    if (!this.bus) await this.connect();
    const obj = await this.bus.getProxyObject(busName, path);
    return obj.getInterface(ACCESSIBLE_IFACE);
  }

  async getApplicationList() {
    if (!this.bus) await this.connect();
    const registry = await this._getAccessible('org.a11y.atspi.Registry', '/org/a11y/atspi/accessible/root');
    let count = 0;
    try { count = Number(await registry.GetChildCount()); } catch { count = 0; }
    const apps = [];
    for (let i = 0; i < count; i++) {
      try {
        const [childBus, childPath] = await registry.GetChildAtIndex(i);
        const acc = await this._getAccessible(String(childBus), String(childPath));
        const name = String(await acc.GetName().catch(() => ''));
        let pid = 0;
        try { pid = Number(await acc.GetApplication().then(a => a?.[0]).catch(() => 0)); } catch {}
        apps.push({ name, path: String(childPath), pid, toolkitName: '', version: '' });
      } catch {}
    }
    return apps;
  }

  async getWindowList() {
    if (!this.bus) await this.connect();
    const registry = await this._getAccessible('org.a11y.atspi.Registry', '/org/a11y/atspi/accessible/root');
    let count = 0;
    try { count = Number(await registry.GetChildCount()); } catch { count = 0; }
    const windows = [];
    for (let i = 0; i < count; i++) {
      try {
        const [childBus, childPath] = await registry.GetChildAtIndex(i);
        const acc = await this._getAccessible(String(childBus), String(childPath));
        const appName = String(await acc.GetName().catch(() => ''));
        let wcount = 0;
        try { wcount = Number(await acc.GetChildCount()); } catch {}
        for (let j = 0; j < wcount; j++) {
          try {
            const [wBus, wPath] = await acc.GetChildAtIndex(j);
            const wacc = await this._getAccessible(String(wBus), String(wPath));
            const title = String(await wacc.GetName().catch(() => ''));
            const role = String(await wacc.GetRoleName().catch(() => ''));
            if (role && !/window|frame|dialog/i.test(role) && !title) continue;
            let bounds = { x: 0, y: 0, width: 0, height: 0 };
            try {
              const obj = await this.bus.getProxyObject(String(wBus), String(wPath));
              const comp = obj.getInterface(COMPONENT_IFACE);
              const ext = await comp.GetExtents(0);
              bounds = { x: Number(ext.x ?? ext[0] ?? 0), y: Number(ext.y ?? ext[1] ?? 0), width: Number(ext.width ?? ext[2] ?? 0), height: Number(ext.height ?? ext[3] ?? 0) };
            } catch {}
            windows.push({ title, path: String(wPath), busName: String(wBus), appName, bounds, states: [] });
          } catch {}
        }
      } catch {}
    }
    return windows;
  }

  async _collectElements(busName, path, out, depth = 0, maxDepth = 6) {
    if (depth > maxDepth || out.length > 200) return;
    try {
      const acc = await this._getAccessible(busName, path);
      const name = String(await acc.GetName().catch(() => ''));
      const role = String(await acc.GetRoleName().catch(() => ''));
      let bounds = null;
      try {
        const obj = await this.bus.getProxyObject(busName, path);
        const comp = obj.getInterface(COMPONENT_IFACE);
        const ext = await comp.GetExtents(0);
        bounds = { x: Number(ext.x ?? ext[0] ?? 0), y: Number(ext.y ?? ext[1] ?? 0), width: Number(ext.width ?? ext[2] ?? 0), height: Number(ext.height ?? ext[3] ?? 0) };
      } catch {}
      let actions = [];
      try {
        const obj = await this.bus.getProxyObject(busName, path);
        const act = obj.getInterface(ACTION_IFACE);
        const n = Number(await act.GetNActions().catch(() => 0));
        for (let i = 0; i < n; i++) actions.push(String(await act.GetName(i).catch(() => '')));
      } catch {}
      out.push({ path, busName, role, name, description: '', states: [], attributes: {}, coordinates: bounds, actions, applicationName: '' });
      let count = 0;
      try { count = Number(await acc.GetChildCount()); } catch {}
      for (let i = 0; i < count; i++) {
        try {
          const [cBus, cPath] = await acc.GetChildAtIndex(i);
          await this._collectElements(String(cBus), String(cPath), out, depth + 1, maxDepth);
        } catch {}
      }
    } catch {}
  }

  async findElements(criteria = {}) {
    if (!this.bus) await this.connect();
    const all = [];
    const apps = await this.getApplicationList();
    const targets = criteria.applicationName ? apps.filter(a => (a.name || '').toLowerCase().includes(String(criteria.applicationName).toLowerCase())) : apps;
    for (const app of targets) {
      try {
        const registry = await this._getAccessible('org.a11y.atspi.Registry', '/org/a11y/atspi/accessible/root');
        // find app child by name/path best-effort: walk root children
        let count = Number(await registry.GetChildCount().catch(() => 0));
        for (let i = 0; i < count; i++) {
          try {
            const [cBus, cPath] = await registry.GetChildAtIndex(i);
            const acc = await this._getAccessible(String(cBus), String(cPath));
            const an = String(await acc.GetName().catch(() => ''));
            if (criteria.applicationName && !an.toLowerCase().includes(String(criteria.applicationName).toLowerCase())) continue;
            await this._collectElements(String(cBus), String(cPath), all, 0, 6);
          } catch {}
        }
      } catch {}
    }
    let filtered = all.filter(el => {
      if (criteria.role && !String(el.role).toLowerCase().includes(String(criteria.role).toLowerCase())) return false;
      if (criteria.name && !String(el.name).toLowerCase().includes(String(criteria.name).toLowerCase())) return false;
      if (criteria.description && !String(el.description).toLowerCase().includes(String(criteria.description).toLowerCase())) return false;
      return true;
    });
    if (typeof criteria.index === 'number') filtered = filtered[criteria.index] ? [filtered[criteria.index]] : [];
    return filtered;
  }

  async findElement(criteria = {}) {
    const els = await this.findElements(criteria);
    return els[0] || null;
  }

  async setFocus(path, busName) {
    // best-effort: use GrabFocus on component if possible
    if (!this.bus) await this.connect();
    try {
      const obj = await this.bus.getProxyObject(busName || 'org.a11y.atspi.Registry', path);
      const comp = obj.getInterface(COMPONENT_IFACE);
      await comp.GrabFocus();
      return true;
    } catch { return false; }
  }

  async focusWindow(title) {
    const windows = await this.getWindowList();
    const w = windows.find(x => (x.title || '').toLowerCase().includes(String(title).toLowerCase()) || (x.appName || '').toLowerCase().includes(String(title).toLowerCase()));
    if (!w) throw new Error(`Window not found: ${title}`);
    if (w.busName && w.path) await this.setFocus(w.path, w.busName).catch(() => {});
    return w;
  }
}

export function createATSPIDriver() { return new ATSPIDriver(); }
export { ATSPIDriver };
