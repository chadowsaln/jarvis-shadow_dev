// XDG Desktop Portal integration. The Screenshot portal is the Wayland-safe way to read the screen:
// it asks the desktop (once, or each time, depending on the compositor) and answers with a file URI.
// This client registers the Response listener before asking (so a fast answer is never missed), calls
// Screenshot with the real two-argument signature, and returns the picture's bytes as well as its URI.
import dbus from 'dbus-next';
import fs from 'node:fs/promises';

const PORTAL_BUS = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';
const SCREENSHOT_IFACE = 'org.freedesktop.portal.Screenshot';

// The request object only exists after Screenshot() is called, so introspection would fail. Supply
// the interface by hand: getProxyObject then skips Introspect and the Response subscription adds
// its D-Bus match rule before the call, so an immediate answer is not missed.
const REQUEST_XML = `
<node>
  <interface name="${REQUEST_IFACE}">
    <method name="Close" />
    <signal name="Response">
      <arg type="u" name="response" />
      <arg type="a{sv}" name="results" />
    </signal>
  </interface>
</node>`;

function unwrap(v) {
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}

/** The portal builds a D-Bus object path from the handle token, so it may only hold [A-Za-z0-9_].
 * A token like `jarvis-1795…` makes the request path invalid and every capture fails. */
export function portalToken(token) {
  const clean = String(token ?? '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 120);
  return clean && !/^_*$/.test(clean) ? clean : `jarvis_${Date.now()}`;
}

function fileUriPath(uri) {
  const s = String(uri || '');
  if (!s.startsWith('file://')) return null;
  const rest = s.slice('file://'.length).replace(/^localhost/, '');
  if (!rest.startsWith('/')) return null;
  try { return decodeURIComponent(rest); } catch { return rest; }
}

class DBusIntegration {
  constructor() { this.bus = null; }

  async connect() {
    if (!this.bus) {
      this.bus = dbus.sessionBus();
      // A bus closed mid-handshake emits 'error'; keep that from crashing the sidecar.
      try { this.bus.on?.('error', () => {}); } catch { /* not an emitter */ }
    }
    return this;
  }

  async disconnect() {
    if (this.bus) {
      try { this.bus.disconnect(); } catch { /* already gone */ }
      this.bus = null;
    }
  }

  /** Does this desktop actually export the Screenshot portal? Reads its `version` property. */
  async portalInfo() {
    try {
      if (!this.bus) await this.connect();
      const obj = await this.bus.getProxyObject(PORTAL_BUS, PORTAL_PATH);
      const props = obj.getInterface('org.freedesktop.DBus.Properties');
      const v = unwrap(await props.Get(SCREENSHOT_IFACE, 'version'));
      return { ok: true, version: Number(v) || 0 };
    } catch (e) {
      return { ok: false, error: `No screenshot portal (${String(e?.message || e)}). Install xdg-desktop-portal and the backend for your desktop.` };
    }
  }

  /**
   * Ask the desktop for a screenshot.
   * @param {string} handleToken unique token for the request
   * @param {boolean} interactive let the user pick screen/window/area
   * @param {boolean} cursor include the pointer (the portal may ignore it)
   * @returns {Promise<{ok:boolean, uri?:string, file?:string, dataUrl?:string, buffer?:Buffer, error?:string}>}
   */
  async requestScreenshot(handleToken = `jarvis_${Date.now()}`, interactive = true, cursor = false) {
    if (!this.bus) await this.connect();
    const token = portalToken(handleToken);
    const sender = String(this.bus.name || ':1.0').replace(/^:/, '').replace(/\./g, '_');
    const requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;

    let requestIface;
    try {
      const requestObj = await this.bus.getProxyObject(PORTAL_BUS, requestPath, REQUEST_XML);
      requestIface = requestObj.getInterface(REQUEST_IFACE);
    } catch (e) {
      return { ok: false, error: `The screenshot portal is not available (${String(e?.message || e)}). Install xdg-desktop-portal and the backend for your desktop.` };
    }

    // Listen before asking, as the portal may answer before the method call returns.
    const answer = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ code: 2, results: {}, error: 'The desktop did not answer the screenshot request in time.' }), interactive ? 120_000 : 60_000);
      timer.unref?.();
      requestIface.on('Response', (code, results) => {
        clearTimeout(timer);
        resolve({ code, results: results || {} });
      });
    });

    try {
      const portalObj = await this.bus.getProxyObject(PORTAL_BUS, PORTAL_PATH);
      const portal = portalObj.getInterface(SCREENSHOT_IFACE);
      const options = {
        handle_token: new dbus.Variant('s', token),
        interactive: new dbus.Variant('b', !!interactive),
        modal: new dbus.Variant('b', !!interactive),
      };
      if (cursor) options.cursor = new dbus.Variant('b', true);
      // The real signature is Screenshot(parent_window, options) -> handle, not app_id + parent + options.
      await portal.Screenshot('', options);
    } catch (e) {
      return { ok: false, error: `The screenshot portal refused the request (${String(e?.message || e)}).` };
    }

    const { code, results, error } = await answer;
    if (code === 1) return { ok: false, error: 'The screenshot was not allowed: the desktop asked, and the answer was no.' };
    if (code !== 0) return { ok: false, error: error || 'The desktop could not take the screenshot.' };

    const uri = String(unwrap(results?.uri) ?? '');
    if (!uri) return { ok: false, error: 'The portal answered without a picture.' };
    const file = fileUriPath(uri);
    if (!file) return { ok: false, error: `The portal answered with a link that is not a local file: ${uri}` };

    try {
      const buffer = await fs.readFile(file);
      return { ok: true, uri, file, buffer, dataUrl: `image/png;base64,${buffer.toString('base64')}` };
    } catch (e) {
      return { ok: false, error: `The portal's picture could not be read (${String(e?.message || e)}).` };
    }
  }
}

let instance = null;
export function createDBusIntegration() { return new DBusIntegration(); }
export async function getDBusIntegration() {
  if (!instance) { instance = new DBusIntegration(); await instance.connect().catch(() => {}); }
  return instance;
}
export { DBusIntegration };
export { fileUriPath };
