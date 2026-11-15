import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const KEY_MAP = {
  enter: 'KEY_ENTER', return: 'KEY_ENTER', tab: 'KEY_TAB', escape: 'KEY_ESC', esc: 'KEY_ESC',
  space: 'KEY_SPACE', backspace: 'KEY_BACKSPACE', delete: 'KEY_DELETE',
  up: 'KEY_UP', down: 'KEY_DOWN', left: 'KEY_LEFT', right: 'KEY_RIGHT',
  home: 'KEY_HOME', end: 'KEY_END', pageup: 'KEY_PAGEUP', pagedown: 'KEY_PAGEDOWN',
  control: 'KEY_LEFTCTRL', ctrl: 'KEY_LEFTCTRL', shift: 'KEY_LEFTSHIFT',
  alt: 'KEY_LEFTALT', meta: 'KEY_LEFTMETA', super: 'KEY_LEFTMETA',
};

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} exited ${code}`)));
  });
}

class YdotoolBackend {
  constructor() {
    this.socket = process.env.YDOTOOL_SOCKET || `/run/user/${process.getuid?.() || 1000}/.ydotool_socket`;
  }
  getBackend() { return 'ydotool'; }
  async isAvailable() {
    try {
      await run('ydotool', ['--help']);
      await fs.access(this.socket).catch(() => {});
      return true;
    } catch { return false; }
  }
  async move(x, y) { await run('ydotool', ['mousemove', '--absolute', '-x', String(Math.round(x)), '-y', String(Math.round(y))], { env: { ...process.env, YDOTOOL_SOCKET: this.socket } }); }
  async click(x, y, button = 'left') {
    if (typeof x === 'number' && typeof y === 'number') await this.move(x, y);
    const map = { left: '0xC0', right: '0xC1', middle: '0xC2' };
    await run('ydotool', ['click', map[button] || '0xC0'], { env: { ...process.env, YDOTOOL_SOCKET: this.socket } });
  }
  async doubleClick(x, y) { await this.click(x, y); await this.click(x, y); }
  async drag(fromX, fromY, toX, toY) {
    await this.move(fromX, fromY);
    await run('ydotool', ['mousedown', '0'], { env: { ...process.env, YDOTOOL_SOCKET: this.socket } });
    await this.move(toX, toY);
    await run('ydotool', ['mouseup', '0'], { env: { ...process.env, YDOTOOL_SOCKET: this.socket } });
  }
  async scroll(x, y, dx = 0, dy = 0) { if (typeof x === 'number') await this.move(x, y); if (dy) await run('ydotool', ['mousemove', '--wheel', '--', '0', String(-dy)], { env: { ...process.env, YDOTOOL_SOCKET: this.socket } }); }
  async type(text, delayMs = 10) { await run('ydotool', ['type', '--key-delay', String(delayMs), '--', String(text)], { env: { ...process.env, YDOTOOL_SOCKET: this.socket } }); }
  async press(key) { const k = KEY_MAP[String(key).toLowerCase()] || key; await run('ydotool', ['key', `${k}:1`, `${k}:0`], { env: { ...process.env, YDOTOOL_SOCKET: this.socket } }).catch(async () => run('ydotool', ['key', String(key)], { env: { ...process.env, YDOTOOL_SOCKET: this.socket } })); }
  async hotkey(modifiers = [], key) { const seq = [...modifiers.map(m => KEY_MAP[String(m).toLowerCase()] || m), KEY_MAP[String(key).toLowerCase()] || key]; const down = seq.map(k => `${k}:1`); const up = [...seq].reverse().map(k => `${k}:0`); await run('ydotool', ['key', ...down, ...up], { env: { ...process.env, YDOTOOL_SOCKET: this.socket } }); }
  async waitForIdle() {}
}

let instance = null;
export function createInputSimulator() { return new YdotoolBackend(); }
export async function getInputSimulator() { if (!instance) instance = new YdotoolBackend(); return instance; }
export { YdotoolBackend };
