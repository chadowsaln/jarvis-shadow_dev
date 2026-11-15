import Tesseract from 'tesseract.js';

class OCREngine {
  constructor() { this.ready = false; }
  async initialize(lang = 'eng') { this.lang = lang; this.ready = true; return this; }
  async terminate() { this.ready = false; }
  async recognizeImage(imagePath, opts = {}) {
    const lang = opts.language || this.lang || 'eng';
    const res = await Tesseract.recognize(imagePath, lang);
    const text = res?.data?.text || '';
    return { text, confidence: res?.data?.confidence ?? null };
  }
}

let instance = null;
export function createOCREngine() { return new OCREngine(); }
export async function getOCREngine() { if (!instance) { instance = new OCREngine(); await instance.initialize('eng').catch(() => {}); } return instance; }
export async function quickOCR(imagePath, lang = 'eng') { const e = createOCREngine(); await e.initialize(lang); return e.recognizeImage(imagePath, { language: lang }); }
export { OCREngine };
