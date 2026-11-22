// Linux AT-SPI2 adapter over D-Bus, written against the real interfaces:
//   org.a11y.atspi.Accessible  Name/Description/Parent/ChildCount are *properties*;
//                              GetChildren, GetChildAtIndex, GetRole, GetRoleName,
//                              GetState, GetAttributes are methods.
//   org.a11y.atspi.Application ToolkitName/Version and Id live on the app root.
//   org.a11y.atspi.Component   GetExtents(0) -> (iiii), GrabFocus.
//   org.a11y.atspi.Action      NActions is a property; GetName(i), DoAction(i) are methods.
//   org.a11y.atspi.Text        GetText(0, -1) is a field's value.
// The process id comes from org.freedesktop.DBus.GetConnectionUnixProcessID on the a11y bus.
//
// The driver accepts an injected bus (`connectBus`) so tests can build a fake tree; in production it
// connects to the accessibility bus advertised by org.a11y.Bus.GetAddress on the session bus.
import dbus from 'dbus-next';

const SESSION_BUS_NAME = 'org.a11y.Bus';
const SESSION_BUS_PATH = '/org/a11y/bus';
const SESSION_BUS_IFACE = 'org.a11y.Bus';
const ACCESSIBLE_IFACE = 'org.a11y.atspi.Accessible';
const APPLICATION_IFACE = 'org.a11y.atspi.Application';
const COMPONENT_IFACE = 'org.a11y.atspi.Component';
const ACTION_IFACE = 'org.a11y.atspi.Action';
const TEXT_IFACE = 'org.a11y.atspi.Text';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';
const REGISTRY_BUS = 'org.a11y.atspi.Registry';
const REGISTRY_PATH = '/org/a11y/atspi/accessible/root';
const NULL_PATH = '/org/a11y/atspi/null';
const MAX_ELEMENTS = 400;
// GTK4/libadwaita nests deeply: at depth 8 a Text Editor window exposed 11 of its 118 elements (no
// buttons, no tabs), at 20 it exposed all of them.
const MAX_DEPTH = 20;

// AT-SPI StateType bit positions (atspi-constants.h): word 0 holds the first 32.
export const STATE_NAMES = [
  'INVALID', 'ACTIVE', 'ARMED', 'BUSY', 'CHECKED', 'COLLAPSED', 'DEFUNCT', 'EDITABLE',
  'ENABLED', 'EXPANDABLE', 'EXPANDED', 'FOCUSABLE', 'FOCUSED', 'HAS_TOOLTIP', 'HORIZONTAL',
  'ICONIFIED', 'MODAL', 'MULTI_LINE', 'MULTISELECTABLE', 'OPAQUE', 'PRESSED', 'RESIZABLE',
  'SELECTABLE', 'SELECTED', 'SENSITIVE', 'SHOWING', 'SINGLE_LINE', 'STALE', 'TRANSIENT',
  'VERTICAL', 'VISIBLE', 'MANAGES_DESCENDANTS', 'INDETERMINATE', 'TRUNCATED', 'REQUIRED',
  'INVALID_ENTRY', 'SUPPORTS_AUTOCOMPLETION', 'SELECTABLE_TEXT', 'IS_DEFAULT', 'VISITED',
  'CHECKABLE', 'HAS_POPUP',
];

// Fallback role ids when GetRoleName is not implemented.
const ROLE_NAMES = {
  0: 'INVALID', 1: 'ACCELERATOR_LABEL', 2: 'ALERT', 3: 'ANIMATION', 4: 'ARROW', 5: 'CALENDAR',
  6: 'CANVAS', 7: 'CHECK_BOX', 8: 'CHECK_MENU_ITEM', 9: 'COLOR_CHOOSER', 10: 'COLUMN_HEADER',
  11: 'COMBO_BOX', 12: 'DATE_EDITOR', 13: 'DESKTOP_ICON', 14: 'DESKTOP_FRAME', 15: 'DIALOG',
  16: 'DIRECTORY_PANE', 17: 'DRAWING_AREA', 18: 'FILE_CHOOSER', 19: 'FILLER', 20: 'FONT_CHOOSER',
  21: 'FRAME', 22: 'GLASS_PANE', 23: 'HTML_CONTAINER', 24: 'ICON', 25: 'IMAGE', 26: 'INTERNAL_FRAME',
  27: 'LABEL', 28: 'LAYERED_PANE', 29: 'LIST', 30: 'LIST_ITEM', 31: 'MENU', 32: 'MENU_BAR',
  33: 'MENU_ITEM', 34: 'OPTION_PANE', 35: 'PAGE_TAB', 36: 'PAGE_TAB_LIST', 37: 'PANEL',
  38: 'PASSWORD_TEXT', 39: 'POPUP_MENU', 40: 'PROGRESS_BAR', 41: 'PUSH_BUTTON', 42: 'RADIO_BUTTON',
  43: 'RADIO_MENU_ITEM', 44: 'ROOT_PANE', 45: 'ROW_HEADER', 46: 'SCROLL_BAR', 47: 'SCROLL_PANE',
  48: 'SEPARATOR', 49: 'SLIDER', 50: 'SPIN_BUTTON', 51: 'SPLIT_PANE', 52: 'STATUS_BAR',
  53: 'TABLE', 54: 'TABLE_CELL', 55: 'TABLE_COLUMN_HEADER', 56: 'TABLE_ROW_HEADER',
  57: 'TEAROFF_MENU_ITEM', 58: 'TERMINAL', 59: 'TEXT', 60: 'TOGGLE_BUTTON', 61: 'TOOL_BAR',
  62: 'TOOL_TIP', 63: 'TREE', 64: 'TREE_TABLE', 65: 'UNKNOWN', 66: 'VIEWPORT', 67: 'WINDOW',
  68: 'EXTENDED', 69: 'HEADER', 70: 'FOOTER', 71: 'PARAGRAPH', 72: 'RULER', 73: 'APPLICATION',
  74: 'AUTOCOMPLETE', 75: 'EDITBAR', 76: 'EMBEDDED', 77: 'ENTRY', 78: 'CHART', 79: 'CAPTION',
  80: 'DOCUMENT_FRAME', 81: 'HEADING', 82: 'PAGE', 83: 'SECTION', 84: 'REDUNDANT_OBJECT',
  85: 'FORM', 86: 'LINK', 87: 'INPUT_METHOD_WINDOW', 88: 'TABLE_ROW', 89: 'TREE_ITEM',
  90: 'DOCUMENT_SPREADSHEET', 91: 'DOCUMENT_PRESENTATION', 92: 'DOCUMENT_TEXT', 93: 'DOCUMENT_WEB',
  94: 'DOCUMENT_EMAIL', 95: 'COMMENT', 96: 'LIST_BOX', 97: 'GROUPING', 98: 'IMAGE_MAP',
  99: 'NOTIFICATION', 100: 'INFO_BAR', 101: 'LEVEL_BAR', 102: 'TITLE_BAR', 103: 'BLOCK_QUOTE',
  104: 'AUDIO', 105: 'VIDEO', 106: 'DEFINITION', 107: 'ARTICLE', 108: 'LANDMARK',
  109: 'LOG', 110: 'MARQUEE', 111: 'MATH', 112: 'RATING', 113: 'TIMER', 114: 'STATIC',
  115: 'MATH_FRACTION', 116: 'MATH_ROOT', 117: 'MATH_SCRIPT', 118: 'MATH_ARITHMETIC',
  119: 'MATH_MULTI_SCRIPT', 120: 'MATH_TABLE', 121: 'MATH_TABLE_CELL', 122: 'DESCRIPTION_LIST',
  123: 'DESCRIPTION_TERM', 124: 'DESCRIPTION_VALUE', 125: 'FOOTNOTE', 126: 'CONTENT_DELETION',
  127: 'CONTENT_INSERTION', 128: 'MARK', 129: 'SUGGESTION', 130: 'PUSH_BUTTON_MENU',
  131: 'SWITCH', 132: 'ALERT_DIALOG',
};

const WEB_ROLES = /^(ROLE_(LINK|ENTRY|TEXT|PUSH_BUTTON|CHECK_BOX|RADIO_BUTTON|COMBO_BOX|LIST_ITEM|MENU_ITEM|PAGE_TAB|TOGGLE_BUTTON|SLIDER|SPIN_BUTTON))$/;

function unwrap(v) {
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}

/** "push button" -> ROLE_PUSH_BUTTON; "ROLE_FRAME" stays as it is; "check menu item" -> ROLE_CHECK_MENU_ITEM. */
export function normalizeRole(name) {
  const s = String(name ?? '').trim();
  if (!s) return '';
  if (/^ROLE_/i.test(s)) return s.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return `ROLE_${s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
}

export function decodeStates(words) {
  const out = [];
  if (!Array.isArray(words)) return out;
  for (let bit = 0; bit < words.length * 32; bit++) {
    const word = words[Math.floor(bit / 32)] >>> 0;
    if (word & (1 << (bit % 32))) {
      out.push(`STATE_${STATE_NAMES[bit] || bit}`);
    }
  }
  return out;
}

// A bus that is still completing its handshake emits 'error' when it is closed; a listener keeps that
// from crashing the sidecar, and the caller still gets the real failure from the call it made.
function quiet(bus) {
  try { bus.on?.('error', () => {}); } catch { /* not an emitter */ }
  return bus;
}

async function getAtspiBusAddress() {
  const session = quiet(dbus.sessionBus());
  try {
    const obj = await session.getProxyObject(SESSION_BUS_NAME, SESSION_BUS_PATH);
    const iface = obj.getInterface(SESSION_BUS_IFACE);
    return String(unwrap(await iface.GetAddress()));
  } finally {
    try { session.disconnect(); } catch { /* a broken session bus is reported by the caller */ }
  }
}

async function defaultConnectBus() {
  const addr = await getAtspiBusAddress();
  return quiet(dbus.sessionBus({ busAddress: addr }));
}

class ATSPIDriver {
  constructor({ connectBus = defaultConnectBus, cacheTtlMs = 1500, maxDepth = MAX_DEPTH, maxElements = MAX_ELEMENTS } = {}) {
    this.connectBus = connectBus;
    this.cacheTtlMs = cacheTtlMs;
    this.maxDepth = maxDepth;
    this.maxElements = maxElements;
    this.bus = null;
    this._ifaces = new Map();
    this._cache = new Map();
  }

  async connect() {
    if (this.bus) return this;
    this.bus = quiet(await this.connectBus());
    return this;
  }

  async disconnect() {
    if (this.bus) {
      try { this.bus.disconnect(); } catch { /* already gone */ }
      this.bus = null;
    }
    this._ifaces.clear();
    this._cache.clear();
  }

  _cacheGet(key) {
    const hit = this._cache.get(key);
    if (!hit || Date.now() - hit.at > this.cacheTtlMs) return undefined;
    return hit.value;
  }

  _cacheSet(key, value) {
    this._cache.set(key, { at: Date.now(), value });
    return value;
  }

  async _iface(busName, path, name) {
    if (!this.bus) await this.connect();
    const key = `${busName}|${path}|${name}`;
    if (this._ifaces.has(key)) return this._ifaces.get(key);
    const obj = await this.bus.getProxyObject(String(busName), String(path));
    const iface = obj.getInterface(name);
    this._ifaces.set(key, iface);
    return iface;
  }

  async _prop(busName, path, iface, name) {
    try {
      const props = await this._iface(busName, path, PROPERTIES_IFACE);
      return unwrap(await props.Get(iface, name));
    } catch {
      return undefined;
    }
  }

  async _children(busName, path) {
    return this._cacheGet(`children|${busName}|${path}`) ?? this._cacheSet(`children|${busName}|${path}`, await this._readChildren(busName, path));
  }

  async _readChildren(busName, path) {
    let acc;
    try { acc = await this._iface(busName, path, ACCESSIBLE_IFACE); } catch { return []; }
    const clean = (refs) => (Array.isArray(refs) ? refs : [])
      .filter((ref) => Array.isArray(ref) && ref[1] && ref[1] !== NULL_PATH)
      .map(([bus, childPath]) => [String(bus), String(childPath)]);
    try {
      return clean(await acc.GetChildren());
    } catch {
      // Some implementations refuse GetChildren for large trees; the spec's other way is
      // ChildCount (a property) plus GetChildAtIndex (a method).
      const count = Number(unwrap(await this._prop(busName, path, ACCESSIBLE_IFACE, 'ChildCount')) ?? 0);
      if (!count) return [];
      const out = [];
      for (let i = 0; i < Math.min(count, this.maxElements); i++) {
        try { out.push(...clean([await acc.GetChildAtIndex(i)])); } catch { /* index out of range */ }
      }
      return out;
    }
  }

  async _role(busName, path, acc) {
    try {
      const name = await acc.GetRoleName();
      if (name) return normalizeRole(name);
    } catch { /* optional in the spec */ }
    try {
      const id = Number(await acc.GetRole());
      return `ROLE_${ROLE_NAMES[id] || id}`;
    } catch {
      return '';
    }
  }

  async _states(busName, path, acc) {
    try {
      const words = await acc.GetState();
      return decodeStates(Array.isArray(words) ? words : Array.from(words || []));
    } catch {
      return [];
    }
  }

  async _attributes(busName, path) {
    try {
      const attrs = await (await this._iface(busName, path, ACCESSIBLE_IFACE)).GetAttributes();
      if (Array.isArray(attrs)) return Object.fromEntries(attrs.filter((p) => Array.isArray(p) && p.length >= 2).map(([k, v]) => [String(k), String(v)]));
      if (attrs && typeof attrs === 'object') return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(unwrap(v))]));
    } catch { /* not every object has attributes */ }
    return {};
  }

  async _bounds(busName, path) {
    try {
      const comp = await this._iface(busName, path, COMPONENT_IFACE);
      const ext = await comp.GetExtents(0);
      if (Array.isArray(ext)) return { x: Number(ext[0]) || 0, y: Number(ext[1]) || 0, width: Number(ext[2]) || 0, height: Number(ext[3]) || 0 };
      return { x: Number(unwrap(ext?.x)) || 0, y: Number(unwrap(ext?.y)) || 0, width: Number(unwrap(ext?.width)) || 0, height: Number(unwrap(ext?.height)) || 0 };
    } catch { /* no Component */ }
    return null;
  }

  async _actions(busName, path) {
    try {
      const n = Number(unwrap(await this._prop(busName, path, ACTION_IFACE, 'NActions')) ?? 0);
      if (!n) return [];
      const act = await this._iface(busName, path, ACTION_IFACE);
      const names = [];
      for (let i = 0; i < Math.min(n, 24); i++) {
        try { names.push(String(await act.GetName(i))); } catch { /* an action with no name */ }
      }
      return names;
    } catch {
      return [];
    }
  }

  async _value(busName, path, role) {
    if (!WEB_ROLES.test(role) && !/ROLE_(PASSWORD_TEXT|COMBO_BOX)$/.test(role)) return undefined;
    try {
      const text = await (await this._iface(busName, path, TEXT_IFACE)).GetText(0, -1);
      return String(text ?? '').slice(0, 300);
    } catch {
      return undefined;
    }
  }

  async _describe(busName, path, appName, { withValue = true } = {}) {
    try {
      const acc = await this._iface(busName, path, ACCESSIBLE_IFACE);
      const role = await this._role(busName, path, acc);
      const name = String(unwrap(await this._prop(busName, path, ACCESSIBLE_IFACE, 'Name')) ?? '');
      const description = String(unwrap(await this._prop(busName, path, ACCESSIBLE_IFACE, 'Description')) ?? '');
      const [states, attributes, bounds, actions, value] = await Promise.all([
        this._states(busName, path, acc),
        this._attributes(busName, path),
        this._bounds(busName, path),
        this._actions(busName, path),
        withValue ? this._value(busName, path, role) : Promise.resolve(undefined),
      ]);
      return { path: String(path), busName: String(busName), role, name, description, states, attributes, coordinates: bounds, actions, applicationName: appName, ...(value !== undefined ? { value } : {}) };
    } catch {
      return null;
    }
  }

  async _pid(busName) {
    try {
      const reply = await this.bus.call(new dbus.Message({
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'GetConnectionUnixProcessID',
        signature: 's',
        body: [String(busName)],
      }));
      return Number(reply?.body?.[0] ?? 0);
    } catch {
      return 0;
    }
  }

  async getApplicationList() {
    const cached = this._cacheGet('apps');
    if (cached) return cached;
    if (!this.bus) await this.connect();
    const refs = await this._readChildren(REGISTRY_BUS, REGISTRY_PATH);
    const apps = [];
    for (const [busName, path] of refs) {
      try {
        const name = String(unwrap(await this._prop(busName, path, ACCESSIBLE_IFACE, 'Name')) ?? '');
        const toolkitName = String(unwrap(await this._prop(busName, path, APPLICATION_IFACE, 'ToolkitName')) ?? '');
        const version = String(unwrap(await this._prop(busName, path, APPLICATION_IFACE, 'ToolkitVersion')) ?? unwrap(await this._prop(busName, path, APPLICATION_IFACE, 'Version')) ?? '');
        const pid = await this._pid(busName);
        if (name || toolkitName) apps.push({ name, path: String(path), busName: String(busName), pid, toolkitName, version });
      } catch { /* an app that vanished between listing and reading */ }
    }
    return this._cacheSet('apps', apps);
  }

  async getWindowList() {
    const cached = this._cacheGet('windows');
    if (cached) return cached;
    const windows = [];
    for (const app of await this.getApplicationList()) {
      for (const [wBus, wPath] of await this._children(app.busName, app.path)) {
        try {
          const el = await this._describe(wBus, wPath, app.name, { withValue: false });
          if (!el) continue;
          if (el.role && !/^(ROLE_(WINDOW|FRAME|DIALOG|ALERT_DIALOG))$/.test(el.role) && !el.name) continue;
          windows.push({ title: el.name, path: el.path, busName: el.busName, appName: app.name, pid: app.pid, bounds: el.coordinates || { x: 0, y: 0, width: 0, height: 0 }, role: el.role, states: el.states });
        } catch { /* a window that vanished */ }
      }
    }
    return this._cacheSet('windows', windows);
  }

  async getFocusedApplication() {
    for (const w of await this.getWindowList()) {
      if (w.states?.some((s) => s === 'STATE_ACTIVE' || s === 'STATE_FOCUSED')) {
        const name = w.appName || w.title;
        if (name) return { name };
      }
    }
    return null;
  }

  async _collectElements(busName, path, out, depth, appName, seen) {
    if (depth > this.maxDepth || out.length >= this.maxElements) return;
    const key = `${busName}|${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    const el = await this._describe(busName, path, appName);
    if (el) out.push(el);
    if (out.length >= this.maxElements) return;
    for (const [cBus, cPath] of await this._children(busName, path)) {
      try {
        await this._collectElements(cBus, cPath, out, depth + 1, appName, seen);
      } catch { /* a control that went away */ }
      if (out.length >= this.maxElements) return;
    }
  }

  async findElements(criteria = {}) {
    if (!this.bus) await this.connect();
    const all = [];
    const apps = await this.getApplicationList();
    const wanted = criteria.applicationName ? String(criteria.applicationName).toLowerCase() : '';
    const targets = wanted ? apps.filter((a) => (a.name || '').toLowerCase().includes(wanted) || (a.toolkitName || '').toLowerCase().includes(wanted)) : apps;
    for (const app of targets) {
      await this._collectElements(app.busName, app.path, all, 0, app.name, new Set());
    }
    const stateWanted = Array.isArray(criteria.states) ? criteria.states.map((s) => String(s).toUpperCase().replace(/^STATE_/, '')) : null;
    let filtered = all.filter((el) => {
      if (criteria.role && !String(el.role).toLowerCase().includes(String(criteria.role).toLowerCase())) return false;
      if (criteria.name && !String(el.name).toLowerCase().includes(String(criteria.name).toLowerCase())) return false;
      if (criteria.description && !String(el.description).toLowerCase().includes(String(criteria.description).toLowerCase())) return false;
      if (stateWanted) {
        const have = new Set((el.states || []).map((s) => String(s).replace(/^STATE_/, '')));
        if (!stateWanted.every((s) => have.has(s))) return false;
      }
      if (criteria.attributes && typeof criteria.attributes === 'object') {
        for (const [k, v] of Object.entries(criteria.attributes)) {
          if (String(el.attributes?.[k] ?? '') !== String(v)) return false;
        }
      }
      return true;
    });
    if (typeof criteria.index === 'number') filtered = filtered[criteria.index] ? [filtered[criteria.index]] : [];
    return filtered;
  }

  async findElement(criteria = {}) {
    return (await this.findElements(criteria))[0] || null;
  }

  async doAction(element, action = 'click') {
    if (!element?.busName || !element?.path) throw new Error('No element to act on.');
    const act = await this._iface(element.busName, element.path, ACTION_IFACE);
    let names = [];
    try { names = await this._actions(element.busName, element.path); } catch { /* fall through to index 0 */ }
    const wanted = names.findIndex((n) => String(n).toLowerCase() === String(action).toLowerCase());
    const index = wanted >= 0 ? wanted : 0;
    const ok = unwrap(await act.DoAction(index));
    if (ok === false) throw new Error(`The element did not accept the "${action}" action.`);
    return { action: names[index] || action, index };
  }

  async setFocus(path, busName) {
    try {
      const comp = await this._iface(busName || REGISTRY_BUS, path, COMPONENT_IFACE);
      return !!(unwrap(await comp.GrabFocus()));
    } catch {
      return false;
    }
  }

  async focusWindow(title) {
    const windows = await this.getWindowList();
    const needle = String(title).toLowerCase();
    const w = windows.find((x) => (x.title || '').toLowerCase().includes(needle) || (x.appName || '').toLowerCase().includes(needle));
    if (!w) throw new Error(`Window not found: ${title}`);
    const focused = await this.setFocus(w.path, w.busName).catch(() => false);
    return { ...w, focused };
  }
}

export function createATSPIDriver(opts) { return new ATSPIDriver(opts); }
export { ATSPIDriver };
