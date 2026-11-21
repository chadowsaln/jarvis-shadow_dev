import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function runHelper(handsPath, args) {
  if (!handsPath) throw new Error('hands helper not available');
  const isMjs = handsPath.endsWith('.mjs');
  const cmd = isMjs ? process.execPath : handsPath;
  const argv = isMjs ? [handsPath, ...args] : args;
  const { stdout, stderr } = await exec(cmd, argv, { maxBuffer: 8 << 20, timeout: 60000, windowsHide: true });
  let parsed = null;
  try { parsed = JSON.parse(String(stdout).trim()); } catch { parsed = { raw: String(stdout).trim() }; }
  if (parsed && parsed.ok === false) throw new Error(parsed.error || stderr || 'helper failed');
  return parsed;
}

export function createHandsInputBackend(handsPath) {
  const H = handsPath;
  return {
    async move(x, y, opts = {}) {
      const args = ['move', String(Math.round(x)), String(Math.round(y))];
      if (opts.relative) args.push('--relative');
      if (opts.durationMs) args.push('--duration', String(opts.durationMs));
      return runHelper(H, args);
    },
    async click(x, y, opts = {}) {
      const args = ['click', '--at', `${Math.round(x)},${Math.round(y)}`];
      if (opts.button && opts.button !== 'left') args.push('--button', opts.button);
      return runHelper(H, args);
    },
    async doubleClick(x, y, opts = {}) {
      return runHelper(H, ['double', '--at', `${Math.round(x)},${Math.round(y)}`]);
    },
    async down(button = 'left') { return runHelper(H, ['mousedown', button]); },
    async up(button = 'left') { return runHelper(H, ['mouseup', button]); },
    async drag(fromX, fromY, toX, toY, opts = {}) {
      return runHelper(H, ['drag', `${Math.round(fromX)},${Math.round(fromY)}`, `${Math.round(toX)},${Math.round(toY)}`]);
    },
    async scroll(x, y, dx = 0, dy = 0) {
      return runHelper(H, ['scroll', '--at', `${Math.round(x)},${Math.round(y)}`, '--dx', String(Math.round(dx)), '--dy', String(Math.round(dy))]);
    },
    async type(text, opts = {}) {
      return runHelper(H, ['type', String(text)]);
    },
    async press(key) { return runHelper(H, ['key', String(key)]); },
    async hotkey(modifiers = [], key) { return runHelper(H, ['key', [...modifiers, key].join('+')]); },
    async relative(dx, dy, opts = {}) {
      return runHelper(H, ['move', String(Math.round(dx)), String(Math.round(dy)), '--relative']);
    },
  };
}

export function createHandsWindowsBackend(handsPath) {
  const H = handsPath;
  return {
    async list() { return runHelper(H, ['windows']); },
    async focus(target) { return runHelper(H, ['focus', String(target)]); },
    async minimize(target) { return runHelper(H, ['window', 'minimize', String(target)]); },
    async maximize(target) { return runHelper(H, ['window', 'maximize', String(target)]); },
    async restore(target) { return runHelper(H, ['window', 'restore', String(target)]); },
    async move(target, x, y) { return runHelper(H, ['window', 'move', String(target), String(x), String(y)]); },
    async resize(target, w, h) { return runHelper(H, ['window', 'resize', String(target), String(w), String(h)]); },
    async monitors() { return runHelper(H, ['monitors']); },
    async isWindowFocused(target) {
      const r = await runHelper(H, ['front']);
      return !!(r && String(r.title || r.app || '').toLowerCase().includes(String(target).toLowerCase()));
    },
    async getWindow(target) {
      const r = await runHelper(H, ['windows']);
      const wins = Array.isArray(r?.windows) ? r.windows : [];
      const t = String(target).toLowerCase();
      return wins.find(w => String(w.title || w.app || '').toLowerCase().includes(t)) || null;
    },
    async getVisibleText(target) { return ''; },
    async findElements(criteria) { return []; },
    async captureHash(target) { return null; },
  };
}

export function createHandsAppsBackend(handsPath) {
  const H = handsPath;
  return {
    async list() { return runHelper(H, ['apps']); }, // may not exist; helper returns error
    async find(query) { return []; },
    async launch(name) {
      // delegate to OS open via sidecar? Just report; real launch handled elsewhere
      return { ok: true, note: 'launch via hands not implemented; use launch_app tool' };
    },
    async quit(name, opts = {}) { return runHelper(H, ['quit', String(name)]); },
    async front() { return runHelper(H, ['front']); },
  };
}

export function createHandsClipboardBackend(handsPath) {
  const H = handsPath;
  return {
    async read() { return runHelper(H, ['clipboard', 'get']); },
    async write(text) { return runHelper(H, ['clipboard', 'set', String(text)]); },
  };
}
