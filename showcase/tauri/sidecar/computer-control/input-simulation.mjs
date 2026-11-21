// Linux input simulation. Two backends, both probed honestly:
//   xdotool  — XTest on X11 (also XWayland windows); works with no daemon.
//   ydotool  — global input on Wayland/X11, but only when ydotoold is listening on its socket.
// `selectInputBackend()` picks one; a backend that is not available throws a clear, actionable error
// instead of silently pretending a click was sent.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const IS_LINUX = process.platform === 'linux';
const UID = process.getuid?.() ?? 1000;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} exited ${code}`)));
  });
}

async function hasCommand(cmd) {
  try { await run(cmd, ['--version']); return true; } catch { return false; }
}

function unavail(reason, remediation) {
  return { ok: false, reason, remediation };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The pointer's current position, when X11/XWayland can tell us (used to glide over a duration). */
async function pointerPosition() {
  if (!process.env.DISPLAY) return null;
  let out;
  try { out = await run('xdotool', ['getmouselocation', '--shell']); } catch { return null; }
  const x = Number(/X=(-?\d+)/.exec(out)?.[1]);
  const y = Number(/Y=(-?\d+)/.exec(out)?.[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Move in steps over durationMs instead of accepting and ignoring it. Without a known start
 * (no X display, or xdotool absent) it makes the single jump the backend can make. */
async function glide(moveTo, x, y, durationMs, stepLimit) {
  const ms = Number(durationMs);
  if (!(ms > 0)) return moveTo(x, y);
  const from = await pointerPosition();
  if (!from) return moveTo(x, y);
  const steps = Math.max(3, Math.min(stepLimit, Math.round(ms / 25)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await moveTo(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
    if (i < steps) await sleep(ms / steps);
  }
}

// ---------------------------------------------------------------- ydotool

const YDOTOOL_REMEDIATION = 'Run the ydotoold daemon for this user (systemctl --user enable --now ydotool, or ydotoold &) and make sure the socket is in XDG_RUNTIME_DIR. On X11, install xdotool instead.';

class YdotoolBackend {
  constructor() {
    this.socket = process.env.YDOTOOL_SOCKET || `${process.env.XDG_RUNTIME_DIR || `/run/user/${UID}`}/.ydotool_socket`;
    this._probe = null;
    this._probeAt = 0;
  }

  getBackend() { return 'ydotool'; }

  async _socketAnswers() {
    let net;
    try { net = await import('node:net'); } catch { return false; }
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (settled) return; settled = true; try { s.destroy(); } catch { /* already closed */ } resolve(ok); };
      const s = net.createConnection(this.socket);
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
      const timer = setTimeout(() => done(false), 800);
      timer.unref?.();
    });
  }

  async probe() {
    if (this._probe && Date.now() - this._probeAt < 5000) return this._probe;
    let result;
    if (!IS_LINUX) {
      result = unavail('Input simulation is for Linux.', '');
    } else if (!(await hasCommand('ydotool'))) {
      result = unavail('ydotool is not installed.', 'Install ydotool (dnf install ydotool / apt install ydotool), or use xdotool on X11.');
    } else {
      let stat = null;
      try { stat = fs.statSync(this.socket); } catch { /* missing */ }
      if (!stat) {
        result = unavail(`ydotoold is not listening: ${this.socket} does not exist.`, YDOTOOL_REMEDIATION);
      } else if (!stat.isSocket()) {
        result = unavail(`${this.socket} exists but is not a socket.`, YDOTOOL_REMEDIATION);
      } else if (!(await this._socketAnswers())) {
        result = unavail(`ydotoold is not accepting connections on ${this.socket}.`, YDOTOOL_REMEDIATION);
      } else {
        result = { ok: true, backend: 'ydotool', socket: this.socket };
      }
    }
    this._probe = result;
    this._probeAt = Date.now();
    return result;
  }

  async isAvailable() { return (await this.probe()).ok; }

  async _ensure() {
    const p = await this.probe();
    if (!p.ok) throw new Error(`Input is unavailable: ${p.reason}${p.remediation ? ` ${p.remediation}` : ''}`);
  }

  _env() { return { ...process.env, YDOTOOL_SOCKET: this.socket }; }
  async _yd(args) { await this._ensure(); return run('ydotool', args, { env: this._env() }); }

  async move(x, y, durationMs) {
    const to = (mx, my) => this._yd(['mousemove', '--absolute', '-x', String(Math.round(mx)), '-y', String(Math.round(my))]);
    await glide(to, x, y, durationMs, 12);
  }
  async relative(dx, dy) {
    await this._yd(['mousemove', '-x', String(Math.round(dx)), '-y', String(Math.round(dy))]);
  }
  async click(x, y, button = 'left') {
    if (Number.isFinite(x) && Number.isFinite(y)) await this.move(x, y);
    const map = { left: '0xC0', right: '0xC1', middle: '0xC2' };
    await this._yd(['click', map[button] || '0xC0']);
  }
  async doubleClick(x, y) {
    if (Number.isFinite(x) && Number.isFinite(y)) await this.move(x, y);
    await this._yd(['click', '--repeat', '2', '--delay', '80', '0xC0']).catch(async () => {
      await this._yd(['click', '0xC0']);
      await this._yd(['click', '0xC0']);
    });
  }
  async down(button = 'left') {
    const map = { left: '0', right: '1', middle: '2' };
    await this._yd(['mousedown', map[button] || '0']);
  }
  async up(button = 'left') {
    const map = { left: '0', right: '1', middle: '2' };
    await this._yd(['mouseup', map[button] || '0']);
  }
  async drag(fromX, fromY, toX, toY) {
    await this.move(fromX, fromY);
    await this.down('left');
    await this.move(toX, toY);
    await this.up('left');
  }
  async scroll(x, y, dx = 0, dy = 0) {
    if (Number.isFinite(x) && Number.isFinite(y)) await this.move(x, y);
    if (dx || dy) await this._yd(['mousemove', '--wheel', '--', String(Math.round(dx)), String(-Math.round(dy))]);
  }
  async type(text, delayMs = 10) {
    await this._yd(['type', '--key-delay', String(delayMs), '--', String(text)]);
  }
  async press(key) {
    const k = KEY_MAP[String(key).toLowerCase()] || key;
    await this._yd(['key', `${k}:1`, `${k}:0`]).catch(async () => this._yd(['key', String(key)]));
  }
  async hotkey(modifiers = [], key) {
    const seq = [...modifiers.map((m) => KEY_MAP[String(m).toLowerCase()] || m), KEY_MAP[String(key).toLowerCase()] || key];
    const down = seq.map((k) => `${k}:1`);
    const up = [...seq].reverse().map((k) => `${k}:0`);
    await this._yd(['key', ...down, ...up]);
  }
  async waitForIdle() {}
}

const KEY_MAP = {
  enter: 'KEY_ENTER', return: 'KEY_ENTER', tab: 'KEY_TAB', escape: 'KEY_ESC', esc: 'KEY_ESC',
  space: 'KEY_SPACE', backspace: 'KEY_BACKSPACE', delete: 'KEY_DELETE',
  up: 'KEY_UP', down: 'KEY_DOWN', left: 'KEY_LEFT', right: 'KEY_RIGHT',
  home: 'KEY_HOME', end: 'KEY_END', pageup: 'KEY_PAGEUP', pagedown: 'KEY_PAGEDOWN',
  control: 'KEY_LEFTCTRL', ctrl: 'KEY_LEFTCTRL', shift: 'KEY_LEFTSHIFT',
  alt: 'KEY_LEFTALT', meta: 'KEY_LEFTMETA', super: 'KEY_LEFTMETA',
};

// ---------------------------------------------------------------- xdotool

const X11_KEYS = {
  enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', space: 'space',
  backspace: 'BackSpace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
  control: 'ctrl', ctrl: 'ctrl', shift: 'shift', alt: 'alt', meta: 'super', super: 'super',
};
const X11_BUTTON = { left: '1', middle: '2', right: '3' };
const X11_SCROLL = { up: '4', down: '5', left: '6', right: '7' };

class XdotoolBackend {
  constructor() { this._probe = null; this._probeAt = 0; }
  getBackend() { return 'xdotool'; }

  async probe() {
    if (this._probe && Date.now() - this._probeAt < 5000) return this._probe;
    let result;
    if (!IS_LINUX) result = unavail('Input simulation is for Linux.', '');
    else if (!process.env.DISPLAY) result = unavail('There is no X display (DISPLAY is not set), so xdotool cannot send input.', 'On Wayland install and run ydotoold, or use an X11 session.');
    else if (!(await hasCommand('xdotool'))) result = unavail('xdotool is not installed.', 'Install xdotool (dnf install xdotool / apt install xdotool).');
    else result = { ok: true, backend: 'xdotool', display: process.env.DISPLAY };
    this._probe = result;
    this._probeAt = Date.now();
    return result;
  }

  async isAvailable() { return (await this.probe()).ok; }
  async _ensure() {
    const p = await this.probe();
    if (!p.ok) throw new Error(`Input is unavailable: ${p.reason}${p.remediation ? ` ${p.remediation}` : ''}`);
  }
  async _x(args) { await this._ensure(); return run('xdotool', args, { env: process.env }); }

  async move(x, y, durationMs) {
    const to = (mx, my) => this._x(['mousemove', '--sync', String(Math.round(mx)), String(Math.round(my))]);
    await glide(to, x, y, durationMs, 20);
  }
  async relative(dx, dy) { await this._x(['mousemove_relative', '--sync', String(Math.round(dx)), String(Math.round(dy))]); }
  async click(x, y, button = 'left') {
    if (Number.isFinite(x) && Number.isFinite(y)) await this._x(['mousemove', '--sync', String(Math.round(x)), String(Math.round(y))]);
    await this._x(['click', X11_BUTTON[button] || '1']);
  }
  async doubleClick(x, y) {
    if (Number.isFinite(x) && Number.isFinite(y)) await this._x(['mousemove', '--sync', String(Math.round(x)), String(Math.round(y))]);
    await this._x(['click', '--repeat', '2', '--delay', '80', '1']);
  }
  async down(button = 'left') { await this._x(['mousedown', X11_BUTTON[button] || '1']); }
  async up(button = 'left') { await this._x(['mouseup', X11_BUTTON[button] || '1']); }
  async drag(fromX, fromY, toX, toY) {
    await this.move(fromX, fromY);
    await this.down('left');
    await this.move(toX, toY);
    await this.up('left');
  }
  async scroll(x, y, dx = 0, dy = 0) {
    if (Number.isFinite(x) && Number.isFinite(y)) await this._x(['mousemove', '--sync', String(Math.round(x)), String(Math.round(y))]);
    const vert = dy > 0 ? X11_SCROLL.down : X11_SCROLL.up;
    const horiz = dx > 0 ? X11_SCROLL.right : X11_SCROLL.left;
    if (dy) await this._x(['click', '--repeat', String(Math.abs(Math.round(dy))), vert]);
    if (dx) await this._x(['click', '--repeat', String(Math.abs(Math.round(dx))), horiz]);
  }
  async type(text, delayMs = 10) { await this._x(['type', '--delay', String(delayMs), '--', String(text)]); }
  async press(key) {
    const k = X11_KEYS[String(key).toLowerCase()] || String(key);
    await this._x(['key', '--clearmodifiers', k]);
  }
  async hotkey(modifiers = [], key) {
    const mods = modifiers.map((m) => X11_KEYS[String(m).toLowerCase()] || String(m));
    const k = X11_KEYS[String(key).toLowerCase()] || String(key);
    await this._x(['key', '--clearmodifiers', [...mods, k].join('+')]);
  }
  async waitForIdle() {}
}

// ---------------------------------------------------------------- selection

function isWayland() {
  return !!process.env.WAYLAND_DISPLAY || /wayland/i.test(process.env.XDG_SESSION_TYPE || '');
}

/** Pick the backend that can actually send input here. Ydotool is preferred on Wayland; xdotool on X11. */
export async function selectInputBackend() {
  if (!IS_LINUX) return null;
  const yd = new YdotoolBackend();
  const xd = new XdotoolBackend();
  if (isWayland()) {
    if ((await yd.probe()).ok) return yd;
    if ((await xd.probe()).ok) return xd;
    return yd;
  }
  if ((await xd.probe()).ok) return xd;
  if ((await yd.probe()).ok) return yd;
  return yd;
}

let instance = null;
/** Synchronous constructor kept for callers that only need the ydotool object. */
export function createInputSimulator() { return new YdotoolBackend(); }
export async function getInputSimulator() { if (!instance) instance = await selectInputBackend(); return instance || new YdotoolBackend(); }
export { YdotoolBackend, XdotoolBackend };
