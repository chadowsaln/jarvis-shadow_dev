// Linux input through the XDG desktop portal and libei: the path that works on Wayland without
// root, uinput or a daemon. The `roamies-input` helper (src-tauri/input-linux) does the portal
// handshake once and then reads one JSON command per line; this class is its Node half.
//
// The helper is only started when an action needs it, and it stays up so the consent dialog is
// shown once per app run (or never again, when the portal keeps the restore token).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evdevCode } from './input-simulation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = 'roamies-input';
const READY_TIMEOUT_MS = Number(process.env.ROAMIES_INPUT_TIMEOUT_MS) || 120_000;
const CALL_TIMEOUT_MS = 15_000;

const REMEDIATION = 'Run ./build.sh in showcase/tauri to build the roamies-input helper, or set ROAMIES_INPUT to its path.';

// A hard sidecar exit would otherwise leave the helper holding an open portal session.
const LIVE = new Set();
process.once('exit', () => {
  for (const child of LIVE) {
    try { child.kill(); } catch { /* already gone */ }
  }
});

function hostTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return `${arch}-unknown-linux-gnu`;
}

/** Where the helper is: the app's own binary, the dev build next to the shell, or PATH. */
export function findInputHelper(env = process.env) {
  const candidates = [];
  if (env.ROAMIES_INPUT) candidates.push(env.ROAMIES_INPUT);
  candidates.push(path.join(path.dirname(process.execPath), HELPER));
  candidates.push(path.join(HERE, '..', '..', 'src-tauri', 'binaries', `${HELPER}-${hostTriple()}`));
  candidates.push(path.join(HERE, '..', '..', 'src-tauri', 'input-linux', 'target', 'release', HELPER));
  candidates.push(path.join(HERE, '..', '..', 'src-tauri', 'input-linux', 'target', 'debug', HELPER));
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, HELPER));
  }
  return candidates.find((p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
  }) || null;
}

export class LibeiBackend {
  constructor(opts = {}) {
    this.helper = opts.helper ?? findInputHelper();
    this.text = null;
    this.backend = null;
    this._child = null;
    this._ready = null;
    this._pending = new Map();
    this._nextId = 1;
    this._buffer = '';
    this._probe = null;
    this._probeAt = 0;
    this._dead = null;
    this._fallback = null;
  }

  getBackend() { return this.backend || 'libei'; }

  /** Whether the portal can be used here at all, without asking the user for anything. */
  async probe() {
    if (this._probe && Date.now() - this._probeAt < 10_000) return this._probe;
    const result = await this._probeNow();
    this._probe = result;
    this._probeAt = Date.now();
    return result;
  }

  async _probeNow() {
    if (process.platform !== 'linux') {
      return { ok: false, reason: 'Input through the desktop portal is for Linux.', remediation: '' };
    }
    if (!this.helper) {
      return { ok: false, reason: 'the JARVIS V2 input helper is not installed.', remediation: REMEDIATION };
    }
    const line = await this._runOnce(['probe'], 20_000).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    if (!line?.ok) {
      return { ok: false, reason: line?.reason || 'the desktop portal could not be reached.', remediation: line?.remediation || REMEDIATION };
    }
    // `text` is null until a session is open: the portal's version does not promise ei_text.
    return { ok: true, backend: line.backend, portalVersion: line.portalVersion, text: line.text == null ? null : !!line.text, deviceTypes: line.deviceTypes || '' };
  }

  /** Start the helper with one command and read its single reply line. */
  _runOnce(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      let out = '';
      const child = spawn(this.helper, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill(); reject(new Error('the input helper did not answer in time')); }, timeoutMs);
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', () => {
        clearTimeout(timer);
        const line = out.split('\n').map((l) => l.trim()).filter(Boolean).pop();
        if (!line) return reject(new Error('the input helper said nothing'));
        try { resolve(JSON.parse(line)); } catch { reject(new Error(`the input helper sent something unreadable: ${line.slice(0, 200)}`)); }
      });
    });
  }

  async isAvailable() { return (await this.probe()).ok; }

  /** Start the long-lived session; the first call may show the desktop's consent dialog. */
  _start() {
    if (this._ready) return this._ready;
    if (!this.helper) return Promise.reject(new Error(`Input is unavailable: the JARVIS V2 input helper is not installed. ${REMEDIATION}`));
    this._dead = null;
    this._ready = new Promise((resolve, reject) => {
      const child = spawn(this.helper, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
      this._child = child;
      LIVE.add(child);
      child.on('close', () => LIVE.delete(child));
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('Input is unavailable: the desktop did not answer the remote-control request within two minutes.'));
      }, READY_TIMEOUT_MS);
      const finish = (error, ready) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(ready);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this._buffer += chunk;
        let at;
        while ((at = this._buffer.indexOf('\n')) >= 0) {
          const line = this._buffer.slice(0, at).trim();
          this._buffer = this._buffer.slice(at + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.event === 'ready') {
            this.backend = message.backend || 'libei';
            this.text = !!message.text;
            finish(null, message);
          } else if (message.event === 'error') {
            const reason = message.reason || 'the desktop refused remote control.';
            const remediation = message.remediation ? ` ${message.remediation}` : '';
            this._dead = `${reason}${remediation}`;
            finish(new Error(`Input is unavailable: ${reason}${remediation}`));
          } else if (message.id != null && this._pending.has(message.id)) {
            const { resolve: done, reject: fail, timer: callTimer } = this._pending.get(message.id);
            this._pending.delete(message.id);
            clearTimeout(callTimer);
            if (message.ok) done(message);
            else fail(new Error(message.reason || 'the desktop refused the input'));
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { if (process.env.ROAMIES_TRACE) process.stderr.write(`[roamies-input] ${d}`); });
      child.on('error', (e) => finish(new Error(`Input is unavailable: the input helper could not start (${e.message}). ${REMEDIATION}`)));
      child.on('close', (code) => {
        this._child = null;
        this._ready = null;
        const reason = this._dead || `the input helper stopped (exit ${code})`;
        for (const { reject: fail, timer: callTimer } of this._pending.values()) {
          clearTimeout(callTimer);
          fail(new Error(reason));
        }
        this._pending.clear();
        finish(new Error(`Input is unavailable: ${reason}`));
      });
    });
    return this._ready;
  }

  async _call(cmd, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
    await this._start();
    const id = this._nextId++;
    const line = JSON.stringify({ id, cmd, ...args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`the desktop did not answer the ${cmd} request in time`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._child.stdin.write(`${line}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error(`the input helper could not be reached: ${error.message}`));
      });
    });
  }

  async move(x, y) { await this._call('move', { x, y }); return { ok: true }; }

  async relative(dx, dy) { await this._call('move_relative', { dx, dy }); return { ok: true }; }

  async click(x, y, opts = {}) {
    await this._call('click', { x: Number.isFinite(x) ? x : null, y: Number.isFinite(y) ? y : null, button: opts.button || 'left' });
    return { ok: true };
  }

  async doubleClick(x, y, opts = {}) {
    await this._call('click', { x: Number.isFinite(x) ? x : null, y: Number.isFinite(y) ? y : null, button: opts.button || 'left', count: 2 });
    return { ok: true };
  }

  async down(button = 'left') { await this._call('down', { button }); return { ok: true }; }

  async up(button = 'left') { await this._call('up', { button }); return { ok: true }; }

  async drag(fromX, fromY, toX, toY, opts = {}) {
    await this._call('drag', { fromX, fromY, toX, toY, button: opts.button || 'left' }, 60_000);
    return { ok: true };
  }

  async scroll(x, y, dx = 0, dy = 0) {
    if (Number.isFinite(x) && Number.isFinite(y)) await this.move(x, y);
    await this._call('scroll', { dx, dy });
    return { ok: true };
  }

  /**
   * Text needs the desktop's `ei_text` (GNOME 46+, KDE 6.1+). Where it is missing, typing falls
   * back to ydotool, and if that is not installed the error says exactly which of the two is
   * needed instead of silently typing nothing.
   */
  async type(text, opts = {}) {
    await this._start();
    if (!this.text) {
      const ydotool = await this._ydotool();
      if (ydotool) return ydotool.type(text, opts);
      throw new Error('Typing needs either a newer desktop (text input through libei) or ydotool: install ydotool and start ydotoold, or use linux_set_text on a text field.');
    }
    await this._call('type', { text: String(text) }, 60_000);
    return { ok: true };
  }

  async press(key) {
    await this._call('key', { codes: [this._code(key)] });
    return { ok: true };
  }

  async hotkey(modifiers = [], key) {
    const codes = [...modifiers.map((m) => this._code(m)), this._code(key)];
    await this._call('key', { codes });
    return { ok: true };
  }

  _code(name) {
    const code = evdevCode(name);
    if (code == null) {
      throw new Error(`Cannot send the key "${name}" on Linux: use a letter, a digit, or a name like Enter, Tab, Escape, Space, Backspace, Delete, Home, End, PageUp, PageDown, Left/Right/Up/Down, F1-F12, or Control/Shift/Alt/Super.`);
    }
    return code;
  }

  async _ydotool() {
    if (this._fallback !== null) return this._fallback || null;
    const { YdotoolBackend } = await import('./input-simulation.mjs');
    const backend = new YdotoolBackend();
    const probe = await backend.probe().catch(() => ({ ok: false }));
    this._fallback = probe.ok ? backend : false;
    return this._fallback || null;
  }

  async waitForIdle() {}

  /** Close the session (the portal ends it with the process). */
  close() {
    try { this._child?.stdin.end(); } catch { /* already gone */ }
    try { this._child?.kill(); } catch { /* already gone */ }
    this._child = null;
    this._ready = null;
  }
}
