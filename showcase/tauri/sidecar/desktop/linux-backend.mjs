import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function runCmd(cmd, args = []) {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 5000 });
    return { ok: true, stdout: String(stdout) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), stdout: e?.stdout ? String(e.stdout) : '' };
  }
}

async function writeStdin(cmd, args, text) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    p.stdin.write(String(text)); p.stdin.end();
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
    p.on('error', reject);
  });
}

export function createLinuxInputBackend() {
  return {
    async move(x, y, opts = {}) {
      const { getInputSimulator } = await import('../computer-control/input-simulation.mjs');
      const sim = await getInputSimulator();
      await sim.move(x, y, opts.durationMs);
      return { ok: true };
    },
    async click(x, y, opts = {}) {
      const { getInputSimulator } = await import('../computer-control/input-simulation.mjs');
      const sim = await getInputSimulator();
      await sim.click(x, y, opts.button || 'left');
      return { ok: true };
    },
    async doubleClick(x, y, opts = {}) {
      const { getInputSimulator } = await import('../computer-control/input-simulation.mjs');
      const sim = await getInputSimulator();
      await sim.doubleClick(x, y);
      return { ok: true };
    },
    async down(button = 'left') {
      const { getInputSimulator } = await import('../computer-control/input-simulation.mjs');
      const sim = await getInputSimulator();
      if (typeof sim.down !== 'function') throw new Error('the selected input backend has no mouse-down');
      await sim.down(button);
      return { ok: true };
    },
    async up(button = 'left') {
      const { getInputSimulator } = await import('../computer-control/input-simulation.mjs');
      const sim = await getInputSimulator();
      if (typeof sim.up !== 'function') throw new Error('the selected input backend has no mouse-up');
      await sim.up(button);
      return { ok: true };
    },
    async drag(fromX, fromY, toX, toY, opts = {}) {
      const { getInputSimulator } = await import('../computer-control/input-simulation.mjs');
      const sim = await getInputSimulator();
      await sim.drag(fromX, fromY, toX, toY);
      return { ok: true };
    },
    async scroll(x, y, dx = 0, dy = 0) {
      const { getInputSimulator } = await import('../computer-control/input-simulation.mjs');
      const sim = await getInputSimulator();
      await sim.scroll(x, y, dx, dy);
      return { ok: true };
    },
    async type(text, opts = {}) {
      const { getInputSimulator } = await import('../computer-control/input-simulation.mjs');
      const sim = await getInputSimulator();
      await sim.type(text, opts.delayMs ?? 10);
      return { ok: true };
    },
    async press(key) {
      const { getInputSimulator } = await import('../computer-control/input-simulation.mjs');
      const sim = await getInputSimulator();
      await sim.press(key);
      return { ok: true };
    },
    async hotkey(modifiers = [], key) {
      const { getInputSimulator } = await import('../computer-control/input-simulation.mjs');
      const sim = await getInputSimulator();
      await sim.hotkey(modifiers, key);
      return { ok: true };
    },
    async relative(dx, dy, opts = {}) {
      const { getInputSimulator } = await import('../computer-control/input-simulation.mjs');
      const sim = await getInputSimulator();
      if (typeof sim.relative !== 'function') throw new Error('the selected input backend has no relative move');
      await sim.relative(dx, dy);
      return { ok: true };
    },
  };
}

export async function createLinuxWindowsBackend() {
  return {
    async list() {
      const { createATSPIDriver } = await import('../computer-control/atspi-adapter.mjs');
      const driver = await createATSPIDriver();
      try { return await driver.getWindowList(); } finally { await driver.disconnect(); }
    },
    async focus(target) {
      const { createATSPIDriver } = await import('../computer-control/atspi-adapter.mjs');
      const driver = await createATSPIDriver();
      try { await driver.focusWindow(String(target)); return { ok: true }; } finally { await driver.disconnect(); }
    },
    async minimize(target) {
      const r = await runCmd('wmctrl', ['-r', String(target), '-b', 'add,hidden']);
      if (!r.ok) throw new Error(r.error || 'minimize unsupported');
      return { ok: true };
    },
    async maximize(target) {
      const r = await runCmd('wmctrl', ['-r', String(target), '-b', 'add,maximized_vert,maximized_horz']);
      if (!r.ok) throw new Error(r.error || 'maximize unsupported');
      return { ok: true };
    },
    async restore(target) {
      const r = await runCmd('wmctrl', ['-r', String(target), '-b', 'remove,hidden,maximized_vert,maximized_horz']);
      if (!r.ok) throw new Error(r.error || 'restore unsupported');
      return { ok: true };
    },
    async move(target, x, y) {
      const r = await runCmd('wmctrl', ['-r', String(target), '-e', `0,${x},${y},-1,-1`]);
      if (!r.ok) throw new Error(r.error || 'move unsupported');
      return { ok: true };
    },
    async resize(target, w, h) {
      const r = await runCmd('wmctrl', ['-r', String(target), '-e', `0,-1,-1,${w},${h}`]);
      if (!r.ok) throw new Error(r.error || 'resize unsupported');
      return { ok: true };
    },
    async monitors() {
      const r = await runCmd('xrandr', ['--listmonitors']);
      if (!r.ok) throw new Error(r.error || 'monitors unavailable');
      return r.stdout;
    },
    async isWindowFocused(target) {
      const { createATSPIDriver } = await import('../computer-control/atspi-adapter.mjs');
      const driver = await createATSPIDriver();
      try {
        const wins = await driver.getWindowList();
        const t = String(target).toLowerCase();
        const front = wins.find(w => (w.states || []).includes('STATE_ACTIVE') || (w.states || []).includes('active'));
        return !!front && String(front.title || front.appName || '').toLowerCase().includes(t);
      } finally { await driver.disconnect(); }
    },
    async getWindow(target) {
      const { createATSPIDriver } = await import('../computer-control/atspi-adapter.mjs');
      const driver = await createATSPIDriver();
      try {
        const wins = await driver.getWindowList();
        const t = String(target).toLowerCase();
        return wins.find(w => String(w.title || w.appName || '').toLowerCase().includes(t)) || null;
      } finally { await driver.disconnect(); }
    },
    async getVisibleText(target) { return ''; },
    async findElements(criteria) {
      const { createATSPIDriver } = await import('../computer-control/atspi-adapter.mjs');
      const driver = await createATSPIDriver();
      try { return await driver.findElements(criteria); } finally { await driver.disconnect(); }
    },
    async captureHash(target) { return null; },
  };
}

export function createLinuxAppsBackend() {
  return {
    async list() {
      const { createATSPIDriver } = await import('../computer-control/atspi-adapter.mjs');
      const driver = await createATSPIDriver();
      try { return await driver.getApplicationList(); } finally { await driver.disconnect(); }
    },
    async find(query) {
      const { createATSPIDriver } = await import('../computer-control/atspi-adapter.mjs');
      const driver = await createATSPIDriver();
      try {
        const apps = await driver.getApplicationList();
        const q = String(query).toLowerCase();
        return apps.filter(a => String(a.name || '').toLowerCase().includes(q));
      } finally { await driver.disconnect(); }
    },
    async launch(name) {
      const { spawn } = await import('node:child_process');
      spawn(String(name), [], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    },
    async quit(name, opts = {}) {
      await runCmd('pkill', ['-f', String(name)]);
      return { ok: true };
    },
    async front() {
      const { createATSPIDriver } = await import('../computer-control/atspi-adapter.mjs');
      const driver = await createATSPIDriver();
      try {
        const wins = await driver.getWindowList();
        const active = wins.find(w => (w.states || []).includes('STATE_ACTIVE'));
        return active ? { app: active.appName, title: active.title } : null;
      } finally { await driver.disconnect(); }
    },
  };
}

export function createLinuxClipboardBackend() {
  return {
    async read() {
      let r = await runCmd('wl-paste', []);
      if (r.ok) return r.stdout;
      r = await runCmd('xclip', ['-o', '-selection', 'clipboard']);
      if (r.ok) return r.stdout;
      throw new Error('no clipboard reader available');
    },
    async write(text) {
      try {
        await writeStdin('wl-copy', [], text);
        return { ok: true };
      } catch (e) {
        await writeStdin('xclip', ['-selection', 'clipboard'], text);
        return { ok: true };
      }
    },
  };
}
