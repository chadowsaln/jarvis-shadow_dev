// Batch 8: Screen intelligence (Linux) - portal-only capture, optional local OCR, no persistence, clear errors.
// Focused tests; run: npm test (from sidecar)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  portalAvailableEnv,
  captureViaPortal,
  removeTemp,
  readImageDataUrl,
  screenAnswerText,
  detectTesseract,
  ocrImage,
} from '../screen.mjs';
import { agentCorePreflight } from '../agentcore/preflight.mjs';

const isLinux = process.platform === 'linux';

// --- portal availability is explicit and never implies hidden capture ---
{
  if (!isLinux) {
    const env = portalAvailableEnv();
    assert.equal(env.ok, false);
    assert.match(String(env.reason), /Linux/i);
  } else {
    const hadBus = process.env.DBUS_SESSION_BUS_ADDRESS;
    const hadRun = process.env.XDG_RUNTIME_DIR;
    try {
      delete process.env.DBUS_SESSION_BUS_ADDRESS;
      delete process.env.XDG_RUNTIME_DIR;
      const env = portalAvailableEnv();
      assert.equal(env.ok, false);
      assert.match(String(env.reason), /session bus|portal/i);
      process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/tmp/fake-bus';
      const ok = portalAvailableEnv();
      assert.equal(ok.ok, true);
    } finally {
      if (hadBus == null) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = hadBus;
      if (hadRun == null) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = hadRun;
    }
  }
}

// --- capture requires shell bridge and cleans up temp on failure (no persistence) ---
{
  const r = await captureViaPortal({ askShell: null, interactive: true });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /not connected|desktop shell/i);
}
{
  let seen = null;
  const askShell = async (msg) => { seen = msg; return { ok: false, error: 'The screenshot wasn\'t allowed (the desktop asked, and the answer was no).' }; };
  const r = await captureViaPortal({ askShell, interactive: true });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /not allowed|no/i);
  assert.ok(seen && seen.type === 'screenshot', 'routes through shell screenshot command');
  assert.equal(seen.interactive, true, 'asks for user consent/choice by default');
  assert.ok(typeof seen.file === 'string' && seen.file.includes('roamies-screen-'));
  // temp file must not be left behind on failure
  await assert.rejects(fs.stat(seen.file), /ENOENT/);
}

// --- temp removal and data-url reading (no persistence path) ---
{
  const f = path.join(os.tmpdir(), `roamies-screen-test-${Date.now()}.bin`);
  await fs.writeFile(f, Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]));
  const url = await readImageDataUrl(f, 'image/jpeg');
  assert.ok(url.startsWith('data:image/jpeg;base64,'));
  await removeTemp(f);
  await assert.rejects(fs.stat(f), /ENOENT/);
  await removeTemp(f); // idempotent/no throw
  await removeTemp(null);
}

// --- OCR/screen text reporting: clear reasons, no crash ---
{
  assert.equal(screenAnswerText({ ocrEnabled: false }), '');
  assert.match(screenAnswerText({ ocrEnabled: true, ocr: null }), /not run/i);
  assert.match(screenAnswerText({ ocr: { ok: false, error: 'Local OCR (tesseract) is not installed.' } }), /not installed/i);
  assert.match(screenAnswerText({ ocr: { ok: true, text: '', lang: 'ara+eng' } }), /no readable text/i);
  assert.match(screenAnswerText({ ocr: { ok: true, text: 'مرحبا hello', lang: 'ara+eng' } }), /مرحبا hello/);
}

// --- OCR availability: returns structured result with clear reason when unavailable ---
{
  const det = await detectTesseract();
  assert.equal(typeof det.ok, 'boolean');
  if (!det.ok) {
    assert.match(String(det.reason || ''), /tesseract|OCR|not installed|Linux/i);
    const r = await ocrImage(path.join(os.tmpdir(), 'nope.jpg'));
    assert.equal(r.ok, false);
    assert.match(String(r.error || ''), /tesseract|OCR|not installed/i);
  } else {
    assert.ok(det.version == null || typeof det.version === 'string');
  }
}

// --- Agent Core preflight: screen tools are routed/guarded with clear reasons ---
{
  if (isLinux) {
    const hadBus = process.env.DBUS_SESSION_BUS_ADDRESS;
    const hadRun = process.env.XDG_RUNTIME_DIR;
    try {
      delete process.env.DBUS_SESSION_BUS_ADDRESS;
      delete process.env.XDG_RUNTIME_DIR;
      const a = agentCorePreflight({ toolName: 'screen_capture', args: {} });
      assert.ok(a && a.ok === false, 'denied without session bus');
      assert.match(String(a.reason), /session bus|portal/i);
      const b = agentCorePreflight({ toolName: 'screen_ocr', args: {} });
      assert.ok(b && b.ok === false);
      process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/tmp/fake-bus';
      assert.equal(agentCorePreflight({ toolName: 'screen_capture', args: {} }), null);
      assert.equal(agentCorePreflight({ toolName: 'screen_ocr', args: {} }), null);
    } finally {
      if (hadBus == null) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = hadBus;
      if (hadRun == null) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = hadRun;
    }
  } else {
    const a = agentCorePreflight({ toolName: 'screen_capture', args: {} });
    assert.ok(a && a.ok === false);
    assert.match(String(a.reason), /Linux/i);
  }
}

console.log('screen.test.mjs ok');
