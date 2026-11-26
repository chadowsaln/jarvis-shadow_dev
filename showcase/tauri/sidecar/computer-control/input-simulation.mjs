// Linux input simulation. Two backends, both probed honestly:
//   xdotool  — XTest on X11 (also XWayland windows); works with no daemon.
//   ydotool  — global input on Wayland/X11, but only when ydotoold is listening on its socket.
// `selectInputBackend()` picks one; a backend that is not available throws a clear, actionable error
// instead of silently pretending a click was sent.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

/** Whether the program is on PATH. Asked of the filesystem, not of the program: ydotool 1.x rejects
 * `--version` with "Unknown command" and exit 1, which used to be read as "not installed". */
async function hasCommand(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try { fs.accessSync(path.join(dir, cmd), fs.constants.X_OK); return true; } catch { /* keep looking */ }
  }
  return false;
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

const YDOTOOL_REMEDIATION = 'Run the ydotoold daemon for this user (systemctl --user enable --now ydotoold, or ydotoold &) and make sure the socket is in XDG_RUNTIME_DIR. On X11, install xdotool instead.';

class YdotoolBackend {
  constructor() {
    this.socket = process.env.YDOTOOL_SOCKET || `${process.env.XDG_RUNTIME_DIR || `/run/user/${UID}`}/.ydotool_socket`;
    this._probe = null;
    this._probeAt = 0;
  }

  getBackend() { return 'ydotool'; }

  /** Ask the daemon for a round trip instead of opening a socket: ydotoold listens on a
   * SOCK_SEQPACKET socket, which Node's net cannot connect to (EPROTOTYPE), so a stream connect
   * always failed and every healthy daemon was reported as "not accepting connections".
   * `key 0:1 0:0` sends no real key event; the daemon answers and the client exits 0. */
  async _socketAnswers() {
    try { await run('ydotool', ['key', '0:1', '0:0'], { env: this._env() }); return true; } catch { return false; }
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
      if (!stat || !stat.isSocket() || !(await this._socketAnswers())) {
        // Attempt auto-start via systemctl or daemon
        try {
          await run('systemctl', ['--user', 'start', 'ydotoold']);
          await sleep(200);
          try { stat = fs.statSync(this.socket); } catch { /* still missing */ }
        } catch { /* systemctl unavailable or failed */ }
      }
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
    await this._yd(['click', BUTTON_MASKS[button]?.click || BUTTON_MASKS.left.click]);
  }
  async doubleClick(x, y) {
    if (Number.isFinite(x) && Number.isFinite(y)) await this.move(x, y);
    // ydotool spells them -r/--repeat and -D/--next-delay; there is no --delay, which used to fail
    // and fall back to two separate clicks.
    await this._yd(['click', '--repeat', '2', '--next-delay', '80', '0xC0']).catch(async () => {
      await this._yd(['click', '0xC0']);
      await this._yd(['click', '0xC0']);
    });
  }
  // ydotool 1.x has no mousedown/mouseup commands: the 0x40 bit is a press, 0x80 a release.
  async down(button = 'left') { await this._yd(['click', (BUTTON_MASKS[button] || BUTTON_MASKS.left).down]); }
  async up(button = 'left') { await this._yd(['click', (BUTTON_MASKS[button] || BUTTON_MASKS.left).up]); }
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
  async press(key) { await this._yd(ydotoolKeyArgs([], key)); }
  async hotkey(modifiers = [], key) { await this._yd(ydotoolKeyArgs(modifiers, key)); }
  async waitForIdle() {}
}

// Mouse buttons as ydotool writes them: button number, plus 0x40 (down), 0x80 (up) or both (a click).
const BUTTON_MASKS = {
  left: { click: '0xC0', down: '0x40', up: '0x80' },
  right: { click: '0xC1', down: '0x41', up: '0x81' },
  middle: { click: '0xC2', down: '0x42', up: '0x82' },
};

/** Linux input-event-codes (/usr/include/linux/input-event-codes.h). ydotool 1.x takes these raw
 * numbers: a `KEY_ENTER`-style name is "non-interpretable", so it is ignored and only costs a delay —
 * presses used to do nothing while the tool reported success. */
export const KEYCODES = {
  escape: 1, esc: 1, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
  minus: 12, equal: 13, backspace: 14, tab: 15,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
  leftbrace: 26, rightbrace: 27, enter: 28, return: 28, leftctrl: 29, control: 29, ctrl: 29,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
  semicolon: 39, apostrophe: 40, grave: 41, leftshift: 42, shift: 42, backslash: 43,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
  comma: 51, dot: 52, period: 52, slash: 53, rightshift: 54,
  kpasterisk: 55, leftalt: 56, alt: 56, space: 57, capslock: 58,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68,
  numlock: 69, scrolllock: 70, kp7: 71, kp8: 72, kp9: 73, kpminus: 74, kp4: 75, kp5: 76, kp6: 77, kpplus: 78,
  kp1: 79, kp2: 80, kp3: 81, kp0: 82, kpdot: 83, f11: 87, f12: 88,
  kpenter: 96, rightctrl: 97, kpslash: 98, printscreen: 99, rightalt: 100,
  home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108, pagedown: 109,
  insert: 110, delete: 111, del: 111, mute: 113, volumedown: 114, volumeup: 115,
  leftmeta: 125, meta: 125, super: 125, win: 125, rightmeta: 126, compose: 127,
};

/** The keycode for a key name ("Enter", "KEY_ENTER", "a", "F5", or a number), or null. */
export function evdevCode(key) {
  const raw = String(key ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const code = KEYCODES[lower] ?? KEYCODES[lower.replace(/^key_/, '')];
  if (Number.isInteger(code)) return code;
  // A bare number is a raw keycode, but only after the digit keys ("0" is the 0 key, code 11).
  if (/^\d{1,3}$/.test(raw)) return Number(raw);
  return null;
}

/** `ydotool key` arguments for one key, with optional modifiers held around it. Throws (rather than
 * sending a press that does nothing) when a name has no keycode. */
export function ydotoolKeyArgs(modifiers = [], key) {
  const k = evdevCode(key);
  if (k == null) {
    throw new Error(`Cannot send the key "${key}" on Linux: use a letter, a digit, or a name like Enter, Tab, Escape, Space, Backspace, Delete, Home, End, PageUp, PageDown, Left/Right/Up/Down, F1-F12, or Control/Shift/Alt/Super.`);
  }
  const mods = modifiers.map((m) => {
    const code = evdevCode(m);
    if (code == null) throw new Error(`Cannot send the modifier "${m}" on Linux: use Control, Shift, Alt or Super.`);
    return code;
  });
  const seq = [...mods, k];
  return ['key', ...seq.map((c) => `${c}:1`), ...[...seq].reverse().map((c) => `${c}:0`)];
}

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

/** The desktop portal's remote-control path (libei), when this machine has it. Wayland's own
 * answer: no root, no uinput, no daemon, and one consent dialog instead of a system setup.
 * Imported lazily so X11 sessions without a portal never pay for it. */
async function portalBackend() {
  try {
    const { LibeiBackend } = await import('./libei-backend.mjs');
    const backend = new LibeiBackend();
    const probe = await backend.probe();
    return probe.ok ? backend : null;
  } catch {
    return null;
  }
}

/** Which backends to try, best first, as a pure function so the choice is testable without a
 * desktop. Wayland has no XTest, so the portal leads there; on X11 xdotool is cheapest. */
export function backendOrder({ wayland, portal, ydotool, xdotool }) {
  const order = wayland ? [portal && 'portal', ydotool && 'ydotool', xdotool && 'xdotool'] : [xdotool && 'xdotool', portal && 'portal', ydotool && 'ydotool'];
  return order.filter(Boolean);
}

/** Pick the backend that can actually send input here. */
export async function selectInputBackend() {
  if (!IS_LINUX) return null;
  const yd = new YdotoolBackend();
  const xd = new XdotoolBackend();
  const portal = await portalBackend();
  const order = backendOrder({
    wayland: isWayland(),
    portal: !!portal,
    ydotool: (await yd.probe()).ok,
    xdotool: (await xd.probe()).ok,
  });
  if (order[0] === 'portal') return portal;
  if (order[0] === 'xdotool') return xd;
  return yd;
}

let instance = null;
/** Synchronous constructor kept for callers that only need the ydotool object. */
export function createInputSimulator() { return new YdotoolBackend(); }
export async function getInputSimulator() { if (!instance) instance = await selectInputBackend(); return instance || new YdotoolBackend(); }
export { YdotoolBackend, XdotoolBackend };
