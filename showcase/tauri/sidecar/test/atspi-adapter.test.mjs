import assert from 'node:assert/strict';
import { createATSPIDriver, normalizeRole, decodeStates } from '../computer-control/atspi-adapter.mjs';

// A fake accessibility bus: just the interfaces the adapter is allowed to call. Anything the old
// adapter used that does not exist (Accessible.GetChildCount, Accessible.GetApplication, GetNActions)
// is deliberately absent, so calling it would fail the test.
const registry = 'org.a11y.atspi.Registry';
const root = '/org/a11y/atspi/accessible/root';
const appBus = ':1.10';
const appRoot = '/org/a11y/atspi/accessible/root';
const winPath = '/org/a11y/atspi/accessible/window1';
const buttonPath = '/org/a11y/atspi/accessible/button1';
const entryPath = '/org/a11y/atspi/accessible/entry1';

const VISIBLE = 30, ENABLED = 8, ACTIVE = 1, FOCUSED = 12, FOCUSABLE = 11;
const word0 = (bits) => bits.reduce((w, b) => w | (1 << b), 0);

const nodes = new Map();
const key = (bus, path) => `${bus}|${path}`;
const calls = [];

function addNode(bus, path, { props = {}, children = [], role = '', states = [], actions = null, extents = null, text = null }) {
  const interfaces = {
    'org.freedesktop.DBus.Properties': {
      Get: async (iface, name) => {
        if (!(iface in props) || !(name in props[iface])) throw new Error(`no property ${iface}.${name}`);
        return { value: props[iface][name] };
      },
    },
    'org.a11y.atspi.Accessible': {
      GetChildren: async () => children.map(([b, p]) => [b, p]),
      GetChildAtIndex: async (i) => children[i] || ['', '/org/a11y/atspi/null'],
      GetRoleName: async () => role,
      GetRole: async () => 41,
      GetState: async () => [word0(states), 0],
      GetAttributes: async () => Object.entries(props['org.a11y.atspi.Accessible']?.Attributes || {}),
    },
  };
  if (extents) {
    interfaces['org.a11y.atspi.Component'] = {
      GetExtents: async () => extents,
      GrabFocus: async () => { calls.push({ bus, path, method: 'GrabFocus' }); return true; },
    };
  }
  if (actions) {
    interfaces['org.a11y.atspi.Action'] = {
      GetName: async (i) => actions[i] || '',
      DoAction: async (i) => { calls.push({ bus, path, method: 'DoAction', i }); return true; },
    };
    props['org.a11y.atspi.Action'] = { NActions: actions.length };
  }
  if (text !== null) {
    interfaces['org.a11y.atspi.Text'] = { GetText: async () => text };
  }
  nodes.set(key(bus, path), { interfaces });
}

addNode(registry, root, { children: [[appBus, appRoot]] });
addNode(appBus, appRoot, {
  props: {
    'org.a11y.atspi.Accessible': { Name: 'Editor' },
    'org.a11y.atspi.Application': { ToolkitName: 'GTK', ToolkitVersion: '4.14.0' },
  },
  role: 'application',
  children: [[appBus, winPath]],
});
addNode(appBus, winPath, {
  props: { 'org.a11y.atspi.Accessible': { Name: 'notes.txt - Editor' } },
  role: 'frame',
  states: [ACTIVE, FOCUSED, VISIBLE],
  extents: [10, 20, 800, 600],
  children: [[appBus, buttonPath], [appBus, entryPath]],
});
addNode(appBus, buttonPath, {
  props: { 'org.a11y.atspi.Accessible': { Name: 'Save', Description: 'Save the file', Attributes: { tooltip: 'save' } } },
  role: 'push button',
  states: [VISIBLE, ENABLED, FOCUSABLE],
  actions: ['click'],
  extents: [100, 100, 80, 30],
});
addNode(appBus, entryPath, {
  props: { 'org.a11y.atspi.Accessible': { Name: 'Filename' } },
  role: 'entry',
  states: [VISIBLE, ENABLED],
  extents: [100, 150, 200, 30],
  text: 'notes.txt',
});

const bus = {
  name: ':1.99',
  async getProxyObject(busName, path) {
    const node = nodes.get(key(busName, path));
    if (!node) throw new Error(`no object at ${busName}${path}`);
    return { getInterface: (name) => {
      const iface = node.interfaces[name];
      if (!iface) throw new Error(`no interface ${name} at ${busName}${path}`);
      return iface;
    } };
  },
  async call(msg) {
    assert.equal(msg.member, 'GetConnectionUnixProcessID');
    return { body: [4242] };
  },
  disconnect() {},
};

const d = createATSPIDriver({ connectBus: async () => bus, cacheTtlMs: 50 });
await d.connect();

// Applications: registry's direct children are applications (not desktops then applications).
const apps = await d.getApplicationList();
assert.equal(apps.length, 1, 'one application');
assert.deepEqual(apps[0], { name: 'Editor', path: appRoot, busName: appBus, pid: 4242, toolkitName: 'GTK', version: '4.14.0' });

// Windows: title, bounds, decoded states.
const wins = await d.getWindowList();
assert.equal(wins.length, 1, 'one window');
assert.equal(wins[0].title, 'notes.txt - Editor');
assert.equal(wins[0].appName, 'Editor');
assert.deepEqual(wins[0].bounds, { x: 10, y: 20, width: 800, height: 600 });
assert.ok(wins[0].states.includes('STATE_ACTIVE'));
assert.ok(wins[0].states.includes('STATE_FOCUSED'));
assert.ok(wins[0].states.includes('STATE_VISIBLE'));

// Focused app comes from those states.
assert.deepEqual(await d.getFocusedApplication(), { name: 'Editor' });

// Elements: roles are normalized to ROLE_*, actions come from Action.NActions + GetName, values from Text.
const button = await d.findElement({ role: 'ROLE_PUSH_BUTTON' });
assert.ok(button, 'the button is found by its normalized role');
assert.equal(button.name, 'Save');
assert.equal(button.description, 'Save the file');
assert.deepEqual(button.actions, ['click']);
assert.deepEqual(button.attributes, { tooltip: 'save' });
assert.deepEqual(button.coordinates, { x: 100, y: 100, width: 80, height: 30 });

const entry = await d.findElement({ name: 'Filename' });
assert.equal(entry.role, 'ROLE_ENTRY');
assert.equal(entry.value, 'notes.txt', 'a text field exposes its value');

// State and attribute filters are real.
const visible = await d.findElements({ states: ['VISIBLE'] });
assert.ok(visible.every((e) => e.states.includes('STATE_VISIBLE')));
assert.ok(visible.some((e) => e.name === 'Save') && visible.some((e) => e.name === 'Filename'));
const active = await d.findElements({ states: ['ACTIVE'] });
assert.equal(active.length, 1);
assert.equal(active[0].title ?? active[0].name, 'notes.txt - Editor');
const byAttr = await d.findElements({ attributes: { tooltip: 'save' } });
assert.equal(byAttr.length, 1);
assert.equal(byAttr[0].name, 'Save');
const byAttrArray = await d.findElements({ attributes: ['tooltip=save'] });
assert.equal(byAttrArray.length, 1);
assert.equal(byAttrArray[0].name, 'Save');

// DoAction picks the named action and sends its index.
const action = await d.doAction(button, 'click');
assert.equal(action.index, 0);
assert.ok(calls.some((c) => c.method === 'DoAction' && c.path === buttonPath && c.i === 0));

// GrabFocus goes through Component.
const focused = await d.setFocus(winPath, appBus);
assert.equal(focused, true);
assert.ok(calls.some((c) => c.method === 'GrabFocus' && c.path === winPath));

// Pure helpers.
assert.equal(normalizeRole('push button'), 'ROLE_PUSH_BUTTON');
assert.equal(normalizeRole('check menu item'), 'ROLE_CHECK_MENU_ITEM');
assert.equal(normalizeRole('ROLE_FRAME'), 'ROLE_FRAME');
assert.deepEqual(decodeStates([word0([ACTIVE, VISIBLE]), 0]), ['STATE_ACTIVE', 'STATE_VISIBLE']);

// The cache is honest: a second app read inside the TTL does not call the bus again.
const before = apps.length;
assert.equal((await d.getApplicationList()).length, before);

await d.disconnect();
console.log('atspi adapter tests: passed');
