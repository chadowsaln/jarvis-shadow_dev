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
