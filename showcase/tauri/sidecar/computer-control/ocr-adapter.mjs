// tesseract.js OCR fallback for Linux (used when the native `tesseract` binary is absent).
// The engine downloads language data on first use; if that fails (offline, no cache) the call reports
// the failure instead of returning empty text as if it had read the screen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Tesseract from 'tesseract.js';

const DEFAULT_LANG = 'eng';

// tesseract.js caches downloaded language data in the current directory by default, which would drop
// a multi-megabyte .traineddata file into the project. Keep the cache in the user's temp dir instead.
function cacheDir() {
  const dir = path.join(os.tmpdir(), 'jarvis-v2-ocr');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* fall back to tesseract.js's own choice */ }
  return dir;
}

class OCREngine {
  constructor() {
    this.ready = false;
    this.lang = DEFAULT_LANG;
    this.worker = null;
    this.lastError = null;
  }

  async initialize(lang = DEFAULT_LANG) {
    this.lang = String(lang || DEFAULT_LANG);
    // tesseract.js loads language data lazily on recognize(); there is nothing to prewarm here.
    this.ready = true;
    return this;
  }

  async terminate() {
    this.ready = false;
    if (this.worker) {
      try { await this.worker.terminate(); } catch { /* already stopped */ }
      this.worker = null;
    }
  }

  async recognizeImage(imagePath, opts = {}) {
    const lang = opts.language || this.lang || DEFAULT_LANG;
    try {
      const res = await Tesseract.recognize(imagePath, lang, { cachePath: cacheDir() });
      const text = res?.data?.text || '';
      this.lastError = null;
      return { ok: true, text, confidence: res?.data?.confidence ?? null, lang, engine: 'tesseract.js' };
    } catch (e) {
      this.lastError = String(e?.message || e);
      return { ok: false, text: '', error: `OCR failed (tesseract.js: ${this.lastError}). The language data may not be downloaded yet, or there is no network to fetch it.`, lang, engine: 'tesseract.js' };
    }
  }
}

let instance = null;
export function createOCREngine() { return new OCREngine(); }
export async function getOCREngine() { if (!instance) { instance = new OCREngine(); await instance.initialize(DEFAULT_LANG); } return instance; }
export async function quickOCR(imagePath, lang = DEFAULT_LANG) {
  const e = createOCREngine();
  await e.initialize(lang);
  return e.recognizeImage(imagePath, { language: lang });
}
export { OCREngine };
