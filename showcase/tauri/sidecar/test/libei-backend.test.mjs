// The libei backend talks to `roamies-input` over JSON lines. These tests stand a fake helper in
// its place, so the protocol, the honest failures and the capability flags are checked without a
// desktop portal (and without sending any input anywhere).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LibeiBackend, findInputHelper } from '../computer-control/libei-backend.mjs';

if (process.platform !== 'linux') {
  console.log('libei-backend: skipped (Linux only)');
  process.exit(0);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-libei-'));
const log = path.join(tmp, 'calls.log');
const helper = path.join(tmp, 'roamies-input');

// A stand-in for the Rust helper: same modes, same one-line JSON answers.
await fs.writeFile(helper, `#!/usr/bin/env node
const fs = require('node:fs');
const log = ${JSON.stringify(log)};
const mode = process.argv[2];
const write = (value) => fs.appendFileSync(log, JSON.stringify(value) + '\\n');
if (mode === 'probe') {
  console.log(process.env.FAKE_PROBE || JSON.stringify({ ok: true, backend: 'libei', portalVersion: 2, text: true, deviceTypes: 'keyboard,pointer' }));
  process.exit(0);
}
if (process.env.FAKE_START_ERROR) {
  console.log(JSON.stringify({ event: 'error', reason: process.env.FAKE_START_ERROR, remediation: 'Allow the prompt', denied: true }));
  process.exit(2);
}
console.log(JSON.stringify({ event: 'ready', backend: 'libei', text: process.env.FAKE_TEXT !== '0', pointer: true, keyboard: true }));
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    write(message);
    if (message.cmd === 'type' && process.env.FAKE_TEXT === '0') {
      console.log(JSON.stringify({ id: message.id, ok: false, reason: 'the desktop does not expose text input' }));
    } else {
      console.log(JSON.stringify({ id: message.id, ok: true }));
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`);
await fs.chmod(helper, 0o755);

const oldEnv = { ...process.env };

try {
  // --- probe: no session, no consent dialog, and the flags come from the desktop.
  {
    const backend = new LibeiBackend({ helper });
    const probe = await backend.probe();
    assert.equal(probe.ok, true, 'a reachable portal is reported');
    assert.equal(probe.backend, 'libei');
    assert.equal(probe.text, true);
    assert.equal(probe.portalVersion, 2);
  }

  // --- one session, one line per action, evdev codes for keys.
  {
    await fs.writeFile(log, '');
    const backend = new LibeiBackend({ helper });
    assert.equal(backend.getBackend(), 'libei');
    await backend.move(10, 20);
    await backend.click(30, 40, { button: 'right' });
    await backend.doubleClick(50, 60);
    await backend.scroll(70, 80, 0, -3);
    await backend.press('Enter');
    await backend.hotkey(['Control'], 'c');
    await backend.type('مرحبا');
    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls[0], { id: 1, cmd: 'move', x: 10, y: 20 });
    assert.equal(calls[1].cmd, 'click', 'a click is its own command');
    assert.equal(calls[1].button, 'right');
    assert.equal(calls[2].count, 2, 'a double click is one command with count 2');
    assert.deepEqual(calls[3], { id: 4, cmd: 'move', x: 70, y: 80 }, 'a wheel at a point moves there first');
    assert.deepEqual([calls[4].dx, calls[4].dy], [0, -3]);
    assert.deepEqual(calls[5], { id: 6, cmd: 'key', codes: [28] }, 'Enter is evdev 28');
    assert.deepEqual(calls[6].codes, [29, 46], 'Control+c is held and released together');
    assert.equal(calls[7].cmd, 'type');
    assert.equal(calls[7].text, 'مرحبا', 'text goes as text, not as guessed keycodes');
    assert.equal(backend.text, true);
    backend.close();
  }

  // --- an unknown key is refused here, before anything is sent.
  {
    const backend = new LibeiBackend({ helper });
    await assert.rejects(() => backend.press('Nonesuch'), /Cannot send the key "Nonesuch"/);
    backend.close();
  }

  // --- a desktop without ei_text is known from the ready line, not guessed.
  {
    process.env.FAKE_TEXT = '0';
    const off = new LibeiBackend({ helper });
    await off.move(0, 0);
    assert.equal(off.text, false, 'the ready line says the desktop cannot type text');
    delete process.env.FAKE_TEXT;
    off.close();
  }

  // --- a refused consent is reported with its reason and remediation, not a bare "failed".
  {
    process.env.FAKE_START_ERROR = 'the remote-control request was denied';
    const backend = new LibeiBackend({ helper });
    await assert.rejects(() => backend.move(1, 2), (error) => {
      assert.match(error.message, /remote-control request was denied/);
      assert.match(error.message, /Allow the prompt/, 'the fix is in the message');
      return true;
    });
    delete process.env.FAKE_START_ERROR;
    backend.close();
  }

  // --- no helper: the probe explains what to build and where to point.
  {
    const backend = new LibeiBackend({ helper: '' });
    const probe = await backend.probe();
    assert.equal(probe.ok, false);
    assert.match(probe.reason, /input helper is not installed/);
    assert.match(probe.remediation, /build\.sh|ROAMIES_INPUT/);
    await assert.rejects(() => backend.move(1, 2), /input helper is not installed/);
  }

  // --- the helper search uses ROAMIES_INPUT first, then PATH.
  {
    assert.equal(findInputHelper({ ROAMIES_INPUT: helper, PATH: '' }), helper);
    const dir = path.join(tmp, 'bin');
    await fs.mkdir(dir, { recursive: true });
    const onPath = path.join(dir, 'roamies-input');
    await fs.writeFile(onPath, '#!/bin/sh\nexit 0\n');
    await fs.chmod(onPath, 0o755);
    const found = findInputHelper({ PATH: dir });
    assert.ok(found, 'a helper is found');
    await fs.access(found, fs.constants.X_OK);
    assert.ok(found === onPath || found.includes('input-linux/target'), 'only an executable helper is chosen');
  }
} finally {
  process.env = oldEnv;
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log('libei-backend: ok');
