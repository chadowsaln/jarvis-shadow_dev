import dbus from 'dbus-next';

class DBusIntegration {
  constructor() { this.bus = null; }
  async connect() { if (!this.bus) this.bus = dbus.sessionBus(); return this; }
  async disconnect() { if (this.bus) { try { this.bus.disconnect(); } catch {} this.bus = null; } }
  async requestScreenshot(handleToken = `lb-${Date.now()}`, interactive = true, cursor = false) {
    if (!this.bus) await this.connect();
    const obj = await this.bus.getProxyObject('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop');
    const iface = obj.getInterface('org.freedesktop.portal.Screenshot');
    const appId = '';
    const parentWindow = '';
    const opts = { interactive: new dbus.Variant('b', !!interactive), handle_token: new dbus.Variant('s', String(handleToken)) };
    const reqPath = await iface.Screenshot(appId, parentWindow, opts);
    // best-effort: wait for Response signal on request object
    try {
      const reqObj = await this.bus.getProxyObject('org.freedesktop.portal.Desktop', reqPath);
      const reqIface = reqObj.getInterface('org.freedesktop.portal.Request');
      const uri = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Screenshot portal timeout')), 60000);
        reqIface.on('Response', (code, results) => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error(`Screenshot cancelled/failed (${code})`));
          const u = results?.uri?.value || results?.uri || '';
          resolve(String(u));
        });
      });
      return { uri };
    } catch (e) {
      return { uri: '', error: String(e?.message || e) };
    }
  }
}

let instance = null;
export function createDBusIntegration() { return new DBusIntegration(); }
export async function getDBusIntegration() { if (!instance) { instance = new DBusIntegration(); await instance.connect().catch(() => {}); } return instance; }
export { DBusIntegration };
