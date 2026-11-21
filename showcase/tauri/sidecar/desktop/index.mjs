// Desktop adapter layer — adapters only, no policy and no approvals.
// Backends are injected so tests can use a recording fake. Real backends:
//   Linux: computer-control (AT-SPI + ydotool/wmctrl/xclip)
//   macOS/Windows: the hands helper (ROAMIES_HANDS)
import { createInput } from './input.mjs';
import { createWindows } from './windows.mjs';
import { createApps } from './apps.mjs';
import { createClipboard } from './clipboard.mjs';
import { createVerify } from './verify.mjs';

export function createDesktop(backends = {}) {
  const input = createInput(backends.input);
  const windows = createWindows(backends.windows);
  const apps = createApps(backends.apps);
  const clipboard = createClipboard(backends.clipboard);
  const verify = createVerify({
    isWindowFocused: backends.windows?.isWindowFocused,
    getWindow: backends.windows?.getWindow,
    getVisibleText: backends.windows?.getVisibleText,
    findElements: backends.windows?.findElements,
    readClipboard: () => clipboard.read(),
    captureHash: backends.windows?.captureHash,
    ...(backends.verify || {}),
  });
  return { input, windows, apps, clipboard, verify, backend: backends.name || 'custom' };
}

export async function createDesktopFromEnvironment(opts = {}) {
  const platform = opts.platform || process.platform;
  const handsPath = opts.handsPath ?? (process.env.ROAMIES_HANDS || '');
  if (platform === 'darwin' || platform === 'win32') {
    if (!handsPath) throw new Error('desktop control needs the JARVIS V2 hands helper (ROAMIES_HANDS)');
    const h = await import('./hands-backend.mjs');
    return createDesktop({
      name: 'hands',
      input: h.createHandsInputBackend(handsPath),
      windows: h.createHandsWindowsBackend(handsPath),
      apps: h.createHandsAppsBackend(handsPath),
      clipboard: h.createHandsClipboardBackend(handsPath),
    });
  }
  if (platform === 'linux') {
    const l = await import('./linux-backend.mjs');
    return createDesktop({
      name: 'linux',
      input: l.createLinuxInputBackend(),
      windows: await l.createLinuxWindowsBackend(),
      apps: l.createLinuxAppsBackend(),
      clipboard: l.createLinuxClipboardBackend(),
    });
  }
  throw new Error(`desktop control is not available on ${platform}`);
}

export async function detectCapabilities(opts = {}) {
  const platform = opts.platform || process.platform;
  const handsPath = opts.handsPath ?? (process.env.ROAMIES_HANDS || '');
  const caps = { platform, backend: 'none', input: false, windows: false, apps: false, clipboard: false, verify: false };
  if (platform === 'darwin' || platform === 'win32') {
    if (handsPath) { caps.backend = 'hands'; caps.input = caps.windows = caps.apps = caps.clipboard = true; }
    caps.verify = caps.windows;
    return caps;
  }
  if (platform === 'linux') {
    caps.backend = 'linux';
    try {
      const l = await import('./linux-backend.mjs');
      const input = l.createLinuxInputBackend();
      caps.input = typeof input.click === 'function';
      const windows = await l.createLinuxWindowsBackend();
      caps.windows = typeof windows.list === 'function';
      caps.apps = true;
      caps.clipboard = true;
      caps.verify = caps.windows;
    } catch (e) {
      caps.error = String(e?.message || e);
    }
    return caps;
  }
  return caps;
}

export { createInput, createWindows, createApps, createClipboard, createVerify };
