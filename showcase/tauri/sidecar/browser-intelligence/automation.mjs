// Native Chrome DevTools Protocol (CDP) Browser Automation (V2.2)
// Controls system Chromium/Brave browsers directly over WebSocket without heavy external dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CANDIDATE_BROWSERS = Object.freeze([
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/brave-browser',
  '/snap/bin/chromium',
]);

export function findBrowserExecutable() {
  for (const bin of CANDIDATE_BROWSERS) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

export class BrowserAutomationController {
  constructor(opts = {}) {
    this.executable = opts.executable || findBrowserExecutable();
    this.process = null;
    this.ws = null;
    this.msgId = 0;
    this.pendingRequests = new Map();
    this.sessionId = null;
    this.targetId = null;
    this.wsUrl = null;
    this.userDataDir = opts.userDataDir || null;
    this.isHeadless = opts.headless !== false;
  }

  async launch({ headless = true, url = 'about:blank' } = {}) {
    if (this.process) return { ok: true, alreadyRunning: true };
    if (!this.executable) {
      throw new Error('No supported browser executable found (checked chromium-browser, google-chrome, brave-browser).');
    }

    this.isHeadless = headless;
    if (!this.userDataDir) {
      this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-browser-'));
    }

    const args = [
      headless ? '--headless=new' : '',
      '--remote-debugging-port=0',
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--disable-gpu',
      '--no-sandbox',
      url,
    ].filter(Boolean);

    this.process = spawn(this.executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const wsUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Browser startup timed out waiting for DevTools endpoint.'));
      }, 10000);

      const onData = (chunk) => {
        const text = chunk.toString();
        const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      };

      this.process.stderr.on('data', onData);
      this.process.stdout.on('data', onData);
      this.process.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      this.process.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Browser exited prematurely with code ${code}`));
      });
    });

    this.wsUrl = wsUrl;
    await this._connectWs(wsUrl);

    // Discover initial page target
    const targets = await this.send('Target.getTargets');
    const pageTarget = targets.targetInfos.find((t) => t.type === 'page');
    if (pageTarget) {
      this.targetId = pageTarget.targetId;
      const attachRes = await this.send('Target.attachToTarget', { targetId: this.targetId, flatten: true });
      this.sessionId = attachRes.sessionId;
    }

    // Enable basic domains
    await this.sendToTarget('Page.enable');
    await this.sendToTarget('Runtime.enable');
    await this.sendToTarget('DOM.enable');

    return { ok: true, wsUrl: this.wsUrl, targetId: this.targetId };
  }

  async _connectWs(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error(`WebSocket error: ${e?.message || 'failed to connect'}`));
      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          if (data.id && this.pendingRequests.has(data.id)) {
            const { resolve, reject } = this.pendingRequests.get(data.id);
            this.pendingRequests.delete(data.id);
            if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
            else resolve(data.result);
          }
        } catch {}
      };
      ws.onclose = () => {
        this.ws = null;
        for (const { reject } of this.pendingRequests.values()) {
          reject(new Error('WebSocket closed unexpectedly.'));
        }
        this.pendingRequests.clear();
      };
    });
  }

  send(method, params = {}, sessionId = null) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Browser DevTools is not connected.');
    }
    const id = ++this.msgId;
    const payload = { id, method, params };
    if (sessionId || this.sessionId) payload.sessionId = sessionId || this.sessionId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  sendToTarget(method, params = {}) {
    return this.send(method, params, this.sessionId);
  }

  async navigate(url) {
    if (!this.process) await this.launch();
    let cleanUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('about:') && !url.startsWith('data:')) {
      cleanUrl = `https://${url}`;
    }
    const res = await this.sendToTarget('Page.navigate', { url: cleanUrl });
    await new Promise((r) => setTimeout(r, 600));
    return { ok: true, url: cleanUrl, frameId: res?.frameId };
  }

  async setContent(html) {
    if (!this.process) await this.launch();
    // Get main frame id
    const tree = await this.sendToTarget('Page.getFrameTree');
    const frameId = tree.frameTree.frame.id;
    await this.sendToTarget('Page.setDocumentContent', { frameId, html });
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true, frameId };
  }

  async evaluate(expression) {
    if (!this.process) await this.launch();
    const res = await this.sendToTarget('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Evaluation failed: ${res.exceptionDetails.text || 'script error'}`);
    }
    return res.result?.value;
  }

  async click(selector) {
    const expr = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.click();
        return { ok: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 100) };
      })()
    `;
    const res = await this.evaluate(expr);
    if (!res?.ok) throw new Error(res?.error || `Failed to click ${selector}`);
    return res;
  }

  async fill(selector, value) {
    const expr = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.focus();
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, tag: el.tagName, value: el.value };
      })()
    `;
    const res = await this.evaluate(expr);
    if (!res?.ok) throw new Error(res?.error || `Failed to fill ${selector}`);
    return res;
  }

  async getText(selector = 'body') {
    const expr = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? (el.innerText || el.textContent || '').trim() : '';
      })()
    `;
    return this.evaluate(expr);
  }

  async captureScreenshot() {
    if (!this.process) await this.launch();
    const res = await this.sendToTarget('Page.captureScreenshot', { format: 'png' });
    return { ok: true, format: 'png', base64: res.data };
  }

  async close() {
    try {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      if (this.process) {
        this.process.kill('SIGTERM');
        this.process = null;
      }
      if (this.userDataDir && this.userDataDir.includes('jarvis-browser-')) {
        try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch {}
      }
    } catch {}
    return { ok: true };
  }
}

let activeAutomation = null;
export function getBrowserAutomation() {
  if (!activeAutomation) {
    activeAutomation = new BrowserAutomationController();
  }
  return activeAutomation;
}
