import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createATSPIDriver } from '../computer-control/atspi-adapter.mjs';
import { createInputSimulator, selectInputBackend } from '../computer-control/input-simulation.mjs';
import { createOCREngine } from '../computer-control/ocr-adapter.mjs';
import { createDesktopVerification } from '../computer-control/verification.mjs';
import { detectCapabilities } from '../computer-control/index.mjs';
import { DBusIntegration } from '../computer-control/dbus-integration.mjs';

// --- AT-SPI: the real bus may or may not be reachable here; the call must never throw or lie.
const d = createATSPIDriver({ cacheTtlMs: 0 });
const apps = await d.getApplicationList().catch((e) => { throw e; });
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
  const token = 'test-token';
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
  assert.equal(cap.dataUrl.startsWith('image/png;base64,'), true);
  assert.equal(Buffer.compare(cap.buffer, png), 0, 'the picture bytes are returned, not just the URI');
  assert.equal(seen.args.length, 2, 'Screenshot is called with (parent_window, options)');
  assert.equal(seen.args[0], '');
  assert.equal(seen.args[1].handle_token.value, token);
  assert.equal(seen.args[1].interactive.value, false);
  assert.ok(String(seen.requestXml).includes(`<interface name="org.freedesktop.portal.Request">`), 'the request proxy skips introspection');
  const info = await dbusClient.portalInfo();
  assert.deepEqual(info, { ok: true, version: 2 }, 'the portal probe reads the Screenshot version property');
  assert.deepEqual(seen.prop, ['org.freedesktop.portal.Screenshot', 'version']);
  await fs.rm(shotFile, { force: true });
}

// --- The old stubs are gone, not just bypassed.
const verificationSrc = await fs.readFile(new URL('../computer-control/verification.mjs', import.meta.url), 'utf8');
assert.ok(!verificationSrc.includes('not_implemented'), 'verification has no not_implemented success path');
const toolsSrc = await fs.readFile(new URL('../tools.mjs', import.meta.url), 'utf8');
assert.ok(!toolsSrc.includes('OCR requested via portal'), 'linux_ocr no longer returns the stub text');
assert.ok(!toolsSrc.includes('Screenshot captured: ${result.uri}'), 'linux_capture_screen no longer returns a URI without pixels');

console.log('computer-control tests: passed');
