// Browser Intelligence (V2.2): Unified browser lifecycle, DOM/accessibility inspection,
// session preservation, and structured web page reading.
import {
  BROWSER_ACTIONS,
  browserDiscover,
  browserOpenUrl,
  detectAuthOrCaptchaWall,
  detectPageLang,
  fetchReadablePage,
  isLikelyBrowserApp,
} from '../browser.mjs';

export class BrowserIntelligenceService {
  constructor({ platform = process.platform, execFile = null } = {}) {
    this.platform = platform;
    this.execFile = execFile;
    this.activeSessions = new Map();
  }

  async getInventory({ desktopApps, runningApps } = {}) {
    return browserDiscover({
      platform: this.platform,
      desktopApps,
      runningApps,
    });
  }

  async open(url, opts = {}) {
    return browserOpenUrl(url, { platform: this.platform, execFile: this.execFile, ...opts });
  }

  async read(url, { maxLength = 25000, parseDom = true } = {}) {
    const page = await fetchReadablePage(url, { maxLength });
    const wall = detectAuthOrCaptchaWall(page.html || page.text || '');
    const lang = detectPageLang(page.text || '');

    let elements = [];
    if (parseDom && page.html) {
      elements = this.extractElementsFromHtml(page.html);
    }

    return {
      ok: true,
      url: page.url || url,
      title: page.title || '',
      text: page.text || '',
      truncated: !!page.truncated,
      lang,
      authWall: wall ? wall.kind : null,
      elements: elements.slice(0, 100),
    };
  }

  extractElementsFromHtml(html) {
    const elements = [];
    // Extract interactive elements: buttons, links, inputs
    const aRe = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
    let m;
    while ((m = aRe.exec(html)) !== null && elements.length < 50) {
      const text = m[2].replace(/<[^>]+>/g, '').trim();
      if (text) elements.push({ tag: 'a', role: 'link', text, href: m[1] });
    }

    const btnRe = /<button\s*[^>]*>(.*?)<\/button>/gis;
    while ((m = btnRe.exec(html)) !== null && elements.length < 80) {
      const text = m[1].replace(/<[^>]+>/g, '').trim();
      if (text) elements.push({ tag: 'button', role: 'button', text });
    }

    const inputRe = /<input\s+([^>]*?)>/gis;
    while ((m = inputRe.exec(html)) !== null && elements.length < 100) {
      const attrs = m[1];
      const type = /type=["']([^"']+)["']/i.exec(attrs)?.[1] || 'text';
      const name = /name=["']([^"']+)["']/i.exec(attrs)?.[1] || '';
      const placeholder = /placeholder=["']([^"']+)["']/i.exec(attrs)?.[1] || '';
      elements.push({ tag: 'input', role: 'textbox', type, name, placeholder });
    }

    return elements;
  }
}

let defaultService = null;
export function getBrowserIntelligence(opts = {}) {
  if (!defaultService) defaultService = new BrowserIntelligenceService(opts);
  return defaultService;
}
