import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createATSPIDriver } from '../computer-control/atspi-adapter.mjs';
import { createInputSimulator, selectInputBackend, backendOrder, evdevCode, ydotoolKeyArgs } from '../computer-control/input-simulation.mjs';
import { createOCREngine } from '../computer-control/ocr-adapter.mjs';
import { createDesktopVerification } from '../computer-control/verification.mjs';
import { detectCapabilities } from '../computer-control/index.mjs';
import { DBusIntegration } from '../computer-control/dbus-integration.mjs';

// The input backends under test are Linux-only (xdotool, ydotool, the desktop portal) and the fakes below
// are shell scripts on PATH, so there is nothing to check where the module itself refuses to run. The AT-SPI
// driver keeps its own test (atspi-adapter.test.mjs), which runs everywhere.
if (process.platform !== 'linux') {
  console.log('computer-control: skipped (Linux only)');
  process.exit(0);
}

// --- AT-SPI: the real bus may or may not be reachable here; the call must never throw or lie.
const d = createATSPIDriver({ cacheTtlMs: 0 });
const apps = await d.getApplicationList().catch(() => []);
assert.ok(Array.isArray(apps), 'getApplicationList returns an array');
await d.disconnect().catch(() => {});

// --- Input: createInputSimulator stays the ydotool object; selectInputBackend probes.
const sim = createInputSimulator();
assert.equal(sim.getBackend(), 'ydotool', 'the synchronous factory is the ydotool backend');
const probe = await sim.probe();
assert.equal(typeof probe.ok, 'boolean', 'the probe says whether input works here');
if (!probe.ok) {
  assert.ok(probe.reason, 'an unavailable backend explains why');
  assert.ok(probe.remediation, 'and what to do about it');
}
// The order is the policy: on Wayland the portal (libei) leads because XTest does not exist there,
// then ydotool (needs ydotoold), then XWayland's xdotool. On X11 xdotool is cheapest.
assert.deepEqual(backendOrder({ wayland: true, portal: true, ydotool: true, xdotool: true }), ['portal', 'ydotool', 'xdotool']);
assert.deepEqual(backendOrder({ wayland: true, portal: false, ydotool: true, xdotool: true }), ['ydotool', 'xdotool'], 'without a portal, Wayland still prefers ydotool');
assert.deepEqual(backendOrder({ wayland: false, portal: true, ydotool: true, xdotool: true }), ['xdotool', 'portal', 'ydotool']);
assert.deepEqual(backendOrder({ wayland: true, portal: true, ydotool: false, xdotool: true }), ['portal', 'xdotool'], 'the portal needs neither a daemon nor XWayland');
assert.deepEqual(backendOrder({ wayland: true }), [], 'nothing available is an empty order, never a pretend backend');

const selected = await selectInputBackend();
assert.ok(selected && typeof selected.probe === 'function', 'a backend is selected');
const selectedProbe = await selected.probe();
assert.equal(typeof selectedProbe.ok, 'boolean');

// --- Movement honors duration: a fake xdotool on PATH records the calls.
{
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-xdotool-'));
  const log = path.join(bin, 'calls.log');
  const script = path.join(bin, 'xdotool');
  await fs.writeFile(script, `#!/bin/sh\necho "$@" >> '${log}'\ncase "$1" in\n  --version) echo "xdotool version 3.20211022.1" ;;\n  getmouselocation) echo "X=0"; echo "Y=0" ;;\nesac\nexit 0\n`);
  await fs.chmod(script, 0o755);
  const oldPath = process.env.PATH;
  const oldDisplay = process.env.DISPLAY;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.DISPLAY = ':99';
  try {
    const { XdotoolBackend } = await import('../computer-control/input-simulation.mjs');
    const xd = new XdotoolBackend();
    await xd.move(100, 100, 120);
    let lines = (await fs.readFile(log, 'utf8')).trim().split('\n');
    let moves = lines.filter((l) => l.startsWith('mousemove'));
    assert.ok(moves.length >= 3, 'a duration makes the move glide in steps');
    assert.ok(moves.at(-1).includes('100 100'), 'the glide ends at the target');
    await fs.writeFile(log, '');
    await xd.move(10, 10);
    moves = (await fs.readFile(log, 'utf8')).trim().split('\n').filter((l) => l.startsWith('mousemove'));
    assert.equal(moves.length, 1, 'no duration means a single jump');
  } finally {
    process.env.PATH = oldPath;
    if (oldDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = oldDisplay;
    await fs.rm(bin, { recursive: true, force: true });
  }
}

// The old stub always said yes; a missing socket must not.
if (!process.env.YDOTOOL_SOCKET && !process.env.XDG_RUNTIME_DIR) {
  assert.equal((await new (await import('../computer-control/input-simulation.mjs')).YdotoolBackend().isAvailable()), false, 'no socket means unavailable');
}

// --- ydotool 1.x takes raw keycodes; KEY_* names are "non-interpretable" and only cost a delay, so a
// press sent as KEY_ENTER did nothing while the tool reported success.
assert.equal(evdevCode('Enter'), 28);
assert.equal(evdevCode('KEY_ENTER'), 28);
assert.equal(evdevCode('return'), 28);
assert.equal(evdevCode('a'), 30);
assert.equal(evdevCode('A'), 30);
assert.equal(evdevCode('0'), 11);
assert.equal(evdevCode('F5'), 63);
assert.equal(evdevCode('ArrowLeft'), null, 'only documented names resolve');
assert.equal(evdevCode('Left'), 105);
assert.equal(evdevCode('28'), 28);
assert.deepEqual(ydotoolKeyArgs([], 'Enter'), ['key', '28:1', '28:0']);
assert.deepEqual(ydotoolKeyArgs(['Control'], 'c'), ['key', '29:1', '46:1', '46:0', '29:0'], 'modifiers are held around the key');
assert.deepEqual(ydotoolKeyArgs(['Shift', 'Control'], 's'), ['key', '42:1', '29:1', '31:1', '31:0', '29:0', '42:0']);
assert.throws(() => ydotoolKeyArgs([], 'Nonesuch'), /Cannot send the key "Nonesuch"/, 'an unknown key is refused, not silently typed');
assert.throws(() => ydotoolKeyArgs(['Hyper'], 'a'), /Cannot send the modifier "Hyper"/);

// The daemon must be probed with a round trip: ydotoold's socket is SOCK_SEQPACKET, which net.connect
// rejects with EPROTOTYPE, so a healthy daemon used to read as "not accepting connections".
{
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-ydotool-'));
  const socketPath = path.join(bin, 'sock');
  const log = path.join(bin, 'calls.log');
  // ydotool 1.x rejects --version with exit 1; the probe must not look at that.
  const script = path.join(bin, 'ydotool');
  await fs.writeFile(script, `#!/bin/sh\necho "$@" >> '${log}'\ncase "$1" in\n  --version) echo "ydotool: Unknown command: --version" >&2; exit 1 ;;\n  key) exit 0 ;;\nesac\nexit 0\n`);
  await fs.chmod(script, 0o755);
  const net = await import('node:net');
  const server = net.createServer((s) => s.destroy());
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const oldPath = process.env.PATH, oldSocket = process.env.YDOTOOL_SOCKET;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.YDOTOOL_SOCKET = socketPath;
  try {
    const { YdotoolBackend } = await import('../computer-control/input-simulation.mjs');
    const yd = new YdotoolBackend();
    assert.equal((await yd.probe()).ok, true, 'an installed daemon answers and the probe says so');
    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n');
    assert.ok(calls.some((l) => l.startsWith('key 0:1 0:0')), 'the probe asks the daemon for a no-op round trip');
    assert.ok(!calls.some((l) => l.includes('--version')), 'and never judges by --version');
    await fs.writeFile(log, '');
    await yd.press('Enter');
    assert.ok((await fs.readFile(log, 'utf8')).includes('key 28:1 28:0'), 'press sends the keycode');
  } finally {
    process.env.PATH = oldPath;
    if (oldSocket === undefined) delete process.env.YDOTOOL_SOCKET; else process.env.YDOTOOL_SOCKET = oldSocket;
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(bin, { recursive: true, force: true });
  }
}
// A daemon that is not listening is still reported honestly.
{
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-ydotool2-'));
  await fs.writeFile(path.join(bin, 'ydotool'), '#!/bin/sh\nexit 0\n');
  await fs.chmod(path.join(bin, 'ydotool'), 0o755);
  const oldPath = process.env.PATH, oldSocket = process.env.YDOTOOL_SOCKET;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.YDOTOOL_SOCKET = path.join(bin, 'missing-sock');
  try {
    const { YdotoolBackend } = await import('../computer-control/input-simulation.mjs');
    const p = await new YdotoolBackend().probe();
    assert.equal(p.ok, false);
    assert.match(p.reason, /ydotoold is not listening/);
  } finally {
    process.env.PATH = oldPath;
    if (oldSocket === undefined) delete process.env.YDOTOOL_SOCKET; else process.env.YDOTOOL_SOCKET = oldSocket;
    await fs.rm(bin, { recursive: true, force: true });
  }
}

// --- Capabilities tell the truth rather than claiming everything works.
const caps = await detectCapabilities();
assert.equal(typeof caps.inputReady, 'boolean');
assert.equal(caps.inputReady, caps.input !== 'none', 'inputReady agrees with the backend name');
if (!caps.inputReady) assert.ok(caps.inputReason, 'an unavailable input backend has a reason');
assert.equal(typeof caps.ocr, 'boolean');
assert.ok(['tesseract', 'tesseract.js', 'none'].includes(caps.ocrEngine), 'the OCR engine is named');
if (!caps.ocr) assert.ok(caps.ocrReason, 'an unavailable OCR engine has a reason');
assert.equal(typeof caps.portal, 'string');
if (caps.portal === 'none') assert.ok(caps.portalReason, 'a missing portal has a reason');

// --- OCR engine reports failures instead of empty success.
const ocr = createOCREngine();
await ocr.initialize('eng');
assert.equal(ocr.ready, true);
const missing = await ocr.recognizeImage(path.join(os.tmpdir(), 'definitely-not-an-image.png'), { language: 'eng' });
assert.equal(missing.ok, false, 'OCR on a missing file fails');
assert.ok(missing.error, 'and says why');

// --- The AT-SPI walk is deep enough for GTK4/libadwaita trees (depth 8 saw 11 of 118 elements).
{
  const { ATSPIDriver } = await import('../computer-control/atspi-adapter.mjs');
  assert.ok(new ATSPIDriver().maxDepth >= 16, 'the element walk goes deep enough for GTK4 apps');
}

// --- Verification: real conditions only.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-verify-'));
const file = path.join(tmp, 'out.txt');
await fs.writeFile(file, 'the needle is here');
const v = createDesktopVerification({});
let res = await v.verify([{ type: 'file_exists', target: file }]);
assert.equal(res[0].ok, true);
res = await v.verify([{ type: 'file_exists', target: path.join(tmp, 'nope.txt') }]);
assert.equal(res[0].ok, false);
res = await v.verify([{ type: 'file_contains', target: file, expected: 'needle' }]);
assert.equal(res[0].ok, true);
res = await v.verify([{ type: 'file_contains', target: file, expected: 'haystack' }]);
assert.equal(res[0].ok, false);
res = await v.verify([{ type: 'unknown_condition' }]);
assert.equal(res[0].ok, false, 'an unknown condition fails closed');
res = await v.verify([{ type: 'command_succeeds', target: 'echo' }]);
assert.equal(res[0].ok, false, 'an unchecked command is refused');
res = await v.verify([{ type: 'image_changed', baseline: 'abc' }]);
assert.equal(res[0].ok, false, 'no capture source means no false success');

// Element and text conditions use the AT-SPI driver when it can answer.
let elRes = await v.verify([{ type: 'element_present', target: 'Save' }]);
assert.equal(elRes[0].ok, false, 'no AT-SPI means fail closed, not success');
assert.ok(elRes[0].error);
let textRes = await v.verify([{ type: 'text_present', expected: 'anything' }]);
assert.equal(textRes[0].ok, false, 'no text source means fail closed');
assert.ok(textRes[0].error);

// Real element/text checks with a stub AT-SPI.
const fakeAtspi = {
  async findElements(criteria = {}) {
    const all = [{ name: 'Save' }, { name: 'Filename', value: 'notes.txt' }];
    if (!criteria.name) return all;
    return all.filter((e) => e.name.includes(criteria.name));
  },
  async getWindowList() { return [{ title: 'notes.txt', appName: 'Editor', states: ['STATE_ACTIVE'] }]; },
};
const v2 = createDesktopVerification({ atspi: fakeAtspi });
res = await v2.verify([{ type: 'element_present', target: 'Save' }]);
assert.equal(res[0].ok, true);
res = await v2.verify([{ type: 'element_present', target: 'Delete' }]);
assert.equal(res[0].ok, false);
res = await v2.verify([{ type: 'window_focused', target: 'Editor' }]);
assert.equal(res[0].ok, true);
res = await v2.verify([{ type: 'window_title', expected: 'notes.txt' }]);
assert.equal(res[0].ok, true);
res = await v2.verify([{ type: 'text_present', expected: 'notes.txt' }]);
assert.equal(res[0].ok, true);
res = await v2.verify([{ type: 'text_present', expected: 'absent' }]);
assert.equal(res[0].ok, false);
// `target` is the text, not an application filter: only `app` narrows the search.
const scopedAtspi = {
  async findElements(criteria = {}) {
    if (criteria.applicationName) return [{ name: 'Unrelated' }];
    return [{ name: 'Filename', value: 'notes.txt' }];
  },
};
res = await createDesktopVerification({ atspi: scopedAtspi }).verify([{ type: 'text_present', target: 'notes.txt' }]);
assert.equal(res[0].ok, true, 'target is searched as text without scoping to a fake app');
res = await createDesktopVerification({ atspi: scopedAtspi }).verify([{ type: 'text_present', expected: 'notes.txt', app: 'Editor' }]);
assert.equal(res[0].ok, false, 'app scopes the search');
assert.equal(await v2.verifyAll([{ type: 'element_present', target: 'Save' }]), true);
assert.equal(await v2.verifyAll([{ type: 'unknown_condition' }]), false);

await fs.rm(tmp, { recursive: true, force: true });

// --- Portal capture: the request object is subscribed to before the call, with the real signature.
{
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const shotFile = path.join(os.tmpdir(), `jarvis-portal-${process.pid}.png`);
  await fs.writeFile(shotFile, png);
  const token = 'test_token';
  const requestPath = `/org/freedesktop/portal/desktop/request/1_42/${token}`;
  const requestIface = Object.assign(new EventEmitter(), {});
  const seen = {};
  const fakeBus = {
    name: ':1.42',
    async getProxyObject(name, p, xml) {
      if (p === requestPath) {
        seen.requestXml = xml;
        return { getInterface: () => requestIface };
      }
      return {
        getInterface: (name) => name === 'org.freedesktop.DBus.Properties'
          ? { async Get(iface, prop) { seen.prop = [iface, prop]; return 2; } }
          : {
            async Screenshot(...args) {
              seen.args = args;
              setTimeout(() => requestIface.emit('Response', 0, { uri: `file://${shotFile}` }), 5);
              return requestPath;
            },
          },
      };
    },
  };
  const dbusClient = new DBusIntegration();
  dbusClient.bus = fakeBus;
  const cap = await dbusClient.requestScreenshot(token, false);
  assert.equal(cap.ok, true, 'the portal answer is read back');
  assert.equal(cap.file, shotFile);
  assert.equal(cap.dataUrl.startsWith('data:image/png;base64,'), true);
  assert.equal(Buffer.compare(cap.buffer, png), 0, 'the picture bytes are returned, not just the URI');
  assert.equal(seen.args.length, 2, 'Screenshot is called with (parent_window, options)');
  assert.equal(seen.args[0], '');
  assert.equal(seen.args[1].handle_token.value, token);
  assert.equal(seen.args[1].interactive.value, false);
  assert.ok(String(seen.requestXml).includes(`<interface name="org.freedesktop.portal.Request">`), 'the request proxy skips introspection');
  const info = await dbusClient.portalInfo();
  assert.deepEqual(info, { ok: true, version: 2 }, 'the portal probe reads the Screenshot version property');
  assert.deepEqual(seen.prop, ['org.freedesktop.portal.Screenshot', 'version']);

  // Regression: the portal builds a D-Bus object path from the token, so `jarvis-1795…` (or `lb-…`)
  // made the request path invalid and every capture failed before asking the desktop.
  const { portalToken } = await import('../computer-control/dbus-integration.mjs');
  assert.equal(portalToken('qa-1759'), 'qa_1759');
  assert.equal(portalToken('lb-1759'), 'lb_1759');
  assert.match(portalToken(''), /^jarvis_\d+$/, 'an empty token still gets a valid one');
  assert.match(portalToken(undefined), /^jarvis_\d+$/);
  assert.equal(portalToken('a.b:c/d'), 'a_b_c_d');

  // The same call with a token full of invalid characters asks for a sanitized request path.
  const seenPaths = [];
  const bus2 = {
    name: ':1.42',
    async getProxyObject(name, p, xml) {
      seenPaths.push(p);
      if (p.includes('/request/')) return { getInterface: () => requestIface };
      return { getInterface: () => ({ async Screenshot() { setTimeout(() => requestIface.emit('Response', 1, {}), 5); return p; } }) };
    },
  };
  const dbus2 = new DBusIntegration();
  dbus2.bus = bus2;
  const refused = await dbus2.requestScreenshot('qa-1759', false);
  assert.equal(refused.ok, false, 'a refused screenshot is not reported as success');
  assert.ok(seenPaths.every((p) => /\/request\/1_42\/[A-Za-z0-9_]+$/.test(p) || !p.includes('/request/')), `request paths are valid object paths: ${seenPaths.join(' ')}`);
  assert.ok(seenPaths.some((p) => p.endsWith('/qa_1759')), 'the token was sanitized, not rejected');
  await fs.rm(shotFile, { force: true });
}

// --- The old stubs are gone, not just bypassed.
const verificationSrc = await fs.readFile(new URL('../computer-control/verification.mjs', import.meta.url), 'utf8');
assert.ok(!verificationSrc.includes('not_implemented'), 'verification has no not_implemented success path');
const toolsSrc = await fs.readFile(new URL('../tools.mjs', import.meta.url), 'utf8');
assert.ok(!toolsSrc.includes('OCR requested via portal'), 'linux_ocr no longer returns the stub text');
assert.ok(!toolsSrc.includes('Screenshot captured: ${result.uri}'), 'linux_capture_screen no longer returns a URI without pixels');

console.log('computer-control tests: passed');
