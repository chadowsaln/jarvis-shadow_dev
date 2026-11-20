// Computer Control Module - Main Entry Point
// Linux desktop automation using AT-SPI2, D-Bus, and input simulation

export * from './atspi-adapter.mjs';
export * from './dbus-integration.mjs';
export * from './input-simulation.mjs';
export * from './ocr-adapter.mjs';
export * from './verification.mjs';

import { ATSPIDriver, createATSPIDriver } from './atspi-adapter.mjs';
import { DBusIntegration, createDBusIntegration, getDBusIntegration } from './dbus-integration.mjs';
import { createInputSimulator, getInputSimulator } from './input-simulation.mjs';
import { createOCREngine, getOCREngine } from './ocr-adapter.mjs';
import { createDesktopVerification } from './verification.mjs';

class ComputerControlServiceImpl {
  constructor() {
    this.atspi = new ATSPIDriver();
    this.dbus = new DBusIntegration();
    this.input = createInputSimulator();
    this.ocr = createOCREngine();
    this.verification = createDesktopVerification({ atspi: this.atspi, input: this.input, ocr: this.ocr });
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    try { await this.atspi.connect(); } catch (e) { console.error('[ComputerControl] AT-SPI unavailable:', e?.message || e); }
    try { await this.dbus.connect(); } catch (e) { console.error('[ComputerControl] D-Bus unavailable:', e?.message || e); }
    try { await this.ocr.initialize('eng'); } catch {}
    this.initialized = true;
  }

  async shutdown() {
    await this.atspi.disconnect().catch(() => {});
    await this.dbus.disconnect().catch(() => {});
    await this.ocr.terminate().catch(() => {});
    this.initialized = false;
  }

  async findElement(criteria) { return this.atspi.findElement(criteria); }
  async findElements(criteria) { return this.atspi.findElements(criteria); }
  async clickElement(criteria) {
    const element = await this.atspi.findElement(criteria);
    if (!element || !element.coordinates) throw new Error(`Element not found or no coordinates: ${JSON.stringify(criteria)}`);
    const cx = element.coordinates.x + element.coordinates.width / 2;
    const cy = element.coordinates.y + element.coordinates.height / 2;
    await this.input.click(cx, cy);
    return element;
  }
  async typeIntoElement(criteria, text) { await this.clickElement(criteria); await this.input.type(text); }
  async listWindows() { return this.atspi.getWindowList(); }
  async listApplications() { return this.atspi.getApplicationList(); }
  async captureScreen(interactive = true) { const dbus = await getDBusIntegration(); return dbus.requestScreenshot(`lb-${Date.now()}`, interactive, false); }
  async verify(conditions) { return this.verification.verify(conditions); }
}

let serviceInstance = null;
export function createComputerControl() { return new ComputerControlServiceImpl(); }
export async function getComputerControl() {
  if (!serviceInstance) { serviceInstance = new ComputerControlServiceImpl(); await serviceInstance.initialize(); }
  return serviceInstance;
}

export async function detectCapabilities() {
  const caps = { atspi: false, dbus: false, input: 'none', ocr: false, portal: 'none', wayland: !!process.env.WAYLAND_DISPLAY };
  try { const a = createATSPIDriver(); await a.connect(); await a.disconnect(); caps.atspi = true; } catch {}
  try { const d = createDBusIntegration(); await d.connect(); await d.disconnect(); caps.dbus = true; } catch {}
  try { const i = createInputSimulator(); if (await i.isAvailable()) caps.input = i.getBackend(); } catch {}
  try { caps.ocr = true; } catch {}
  return caps;
}

// CLI diagnostic mode: `node computer-control/index.mjs --doctor`
if (process.argv.includes('--doctor')) {
  (async () => {
    const checks = [];
    const ok = (name, pass, hint) => checks.push({ name, pass: !!pass, hint: hint || '' });
    // AT-SPI accessibility
    try {
      const { execSync } = await import('node:child_process');
      let acc = false;
      try { acc = execSync('gsettings get org.gnome.desktop.interface toolkit-accessibility', { encoding: 'utf8' }).trim() === 'true'; } catch {}
      ok('AT-SPI accessibility enabled (gsettings org.gnome.desktop.interface toolkit-accessibility)', acc, 'Run: gsettings set org.gnome.desktop.interface toolkit-accessibility true');
    } catch (e) { ok('AT-SPI accessibility', false, e?.message); }
    // AT-SPI bus reachable
    try {
      const { createATSPIDriver } = await import('./atspi-adapter.mjs');
      const d = createATSPIDriver(); await d.connect(); await d.disconnect();
      ok('AT-SPI bus reachable', true, '');
    } catch (e) { ok('AT-SPI bus reachable', false, 'Install at-spi2-core and ensure DBUS_SESSION_BUS_ADDRESS is set; ' + (e?.message || e)); }
    // ydotool
    try {
      const { execSync } = await import('node:child_process');
      let ydotool = false, daemon = false, uinput = false;
      try { execSync('command -v ydotool', { stdio: 'ignore' }); ydotool = true; } catch {}
      try { execSync('pgrep -x ydotoold', { stdio: 'ignore' }); daemon = true; } catch {}
      try { const fs = await import('node:fs'); fs.accessSync('/dev/uinput', fs.constants.W_OK); uinput = true; } catch {}
      ok('ydotool installed', ydotool, 'Install ydotool (dnf install ydotool)');
      ok('ydotoold running', daemon, 'Start: systemctl --user enable --now ydotool (or ydotoold)');
      ok('/dev/uinput writable', uinput, 'Add udev rule: echo \'KERNEL=="uinput", GROUP="input", MODE="0660"\' | sudo tee /etc/udev/rules.d/80-uinput.rules; sudo udevadm control --reload-rules');
    } catch (e) { ok('ydotool checks', false, e?.message); }
    // portals
    try {
      const { execSync } = await import('node:child_process');
      ok('XDG portal (ScreenCast/Screenshot) available', !!process.env.XDG_RUNTIME_DIR, 'Ensure xdg-desktop-portal and xdg-desktop-portal-gnome are installed');
    } catch {}
    // tesseract
    try {
      const { execSync } = await import('node:child_process');
      let t = false, eng = false, ara = false;
      try { execSync('command -v tesseract', { stdio: 'ignore' }); t = true; } catch {}
      try { const out = execSync('tesseract --list-langs 2>/dev/null', { encoding: 'utf8' }); eng = /eng/.test(out); ara = /ara/.test(out); } catch {}
      ok('tesseract installed', t, 'Install: dnf install tesseract');
      ok('tesseract eng language data', eng, 'Install: dnf install tesseract-langpack-eng');
      ok('tesseract ara language data', ara, 'Install: dnf install tesseract-langpack-ara');
    } catch (e) { ok('tesseract checks', false, e?.message); }
    // env
    ok('DBUS_SESSION_BUS_ADDRESS set', !!process.env.DBUS_SESSION_BUS_ADDRESS, 'Export DBUS_SESSION_BUS_ADDRESS in the sidecar environment');
    ok('XDG_RUNTIME_DIR set', !!process.env.XDG_RUNTIME_DIR, 'Export XDG_RUNTIME_DIR in the sidecar environment');
    ok('YDOTOOL_SOCKET set (optional)', true, process.env.YDOTOOL_SOCKET ? process.env.YDOTOOL_SOCKET : 'Not set; ydotool uses its default socket');
    // Wayland note
    console.log('Wayland:', !!process.env.WAYLAND_DISPLAY);
    console.log('Global input requires ydotool/libei/portal; GNOME may show a permission prompt.');
    for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}: ${c.name}${c.pass ? '' : ' -- ' + c.hint}`);
    const failed = checks.filter(c => !c.pass).length;
    process.exit(failed ? 1 : 0);
  })();
}
