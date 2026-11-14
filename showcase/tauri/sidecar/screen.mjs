// Screen intelligence (Linux): capture via XDG Desktop Portal only, optional local OCR, no persistence by default.
// All capture goes through the Tauri shell (linux::screenshot -> org.freedesktop.portal.Screenshot).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const LINUX = process.platform === 'linux';
const run = (cmd, args, opts = {}) => new Promise((res) => {
  execFile(cmd, args, { timeout: 30_000, maxBuffer: 8 << 20, windowsHide: true, ...opts }, (err, stdout, stderr) => {
    res({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: err?.code ?? 0 });
  });
});

const nowId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function portalAvailableEnv() {
  // Portal needs a session bus and, on Wayland, a Wayland session (X11 can also have portal). Best-effort check.
  if (!LINUX) return { ok: false, reason: 'Screen capture is available on Linux only.' };
  if (!process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.XDG_RUNTIME_DIR) {
    return { ok: false, reason: 'No desktop session bus found, so the screenshot portal cannot be used.' };
  }
  return { ok: true };
}

/** Capture screen/window/area via XDG Desktop Portal (interactive picker when requested). Temp file removed by caller. */
export async function captureViaPortal({ askShell, interactive = true } = {}) {
  const env = portalAvailableEnv();
  if (!env.ok) return { ok: false, error: env.reason };
  if (typeof askShell !== 'function') return { ok: false, error: 'Screen capture is not connected to the desktop shell.' };
  const file = path.join(os.tmpdir(), `roamies-screen-${nowId()}.jpg`);
  // The Rust side fades overlays and uses the portal; interactive=true lets the user choose screen/window/area (consent each time).
  const res = await askShell({ type: 'screenshot', file, interactive: !!interactive }, 130_000);
  if (!res?.ok) {
    await fs.unlink(file).catch(() => {});
    const err = String(res?.error || 'The desktop could not take a screenshot.');
    return { ok: false, error: err };
  }
  return { ok: true, file, pixels: res.pixels || null, bounds: res.bounds || null };
}

export async function removeTemp(file) {
  if (!file) return;
  try { await fs.unlink(file); } catch {}
}

export async function readImageDataUrl(file, mediaType = 'image/jpeg') {
  const data = await fs.readFile(file);
  return `data:${mediaType};base64,${data.toString('base64')}`;
}

// --- Local OCR (tesseract) ---
let tesseractCache = null;
export async function detectTesseract() {
  if (tesseractCache) return tesseractCache;
  if (!LINUX) return (tesseractCache = { ok: false, reason: 'Local OCR is available on Linux only.' });
  // which/command -v not guaranteed; try --version directly
  const v = await run('tesseract', ['--version']);
  if (v.err && v.err.code === 'ENOENT') {
    return (tesseractCache = { ok: false, reason: 'Local OCR (tesseract) is not installed. Install the `tesseract-ocr` package (and language packs like `tesseract-ocr-ara`/`tesseract-ocr-eng` for Arabic/English) to enable text extraction.' });
  }
  const text = `${v.stdout}\n${v.stderr}`.trim();
  const m = /tesseract\s+([0-9.]+)/i.exec(text);
  return (tesseractCache = { ok: true, version: m ? m[1] : 'unknown' });
}

export async function tesseractLanguages() {
  const det = await detectTesseract();
  if (!det.ok) return { ok: false, reason: det.reason, langs: [] };
  const r = await run('tesseract', ['--list-langs']);
  if (r.err) return { ok: true, langs: [] };
  const langs = String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^List of available languages/i.test(s));
  return { ok: true, langs };
}

function pickOcrLangs(available) {
  const set = new Set(available || []);
  const picked = [];
  if (set.has('ara')) picked.push('ara');
  if (set.has('eng')) picked.push('eng');
  if (set.has('osd')) picked.push('osd');
  if (!picked.length && available?.length) picked.push(available[0]);
  return picked.length ? picked.join('+') : 'eng';
}

export async function ocrImage(file, { preferred = ['ara', 'eng'] } = {}) {
  const det = await detectTesseract();
  if (!det.ok) return { ok: false, error: det.reason };
  const ls = await tesseractLanguages();
  const available = ls.langs || [];
  // prefer Arabic and English when installed
  const want = [];
  for (const l of preferred) if (available.includes(l)) want.push(l);
  const lang = want.length ? want.join('+') : pickOcrLangs(available);
  // stdout output: tesseract <img> stdout -l <lang>
  const r = await run('tesseract', [file, 'stdout', '-l', lang, '--psm', '6'], { timeout: 45_000, maxBuffer: 8 << 20 });
  if (r.err) {
    // fallback: try without explicit lang/psm if lang pack issue
    const r2 = await run('tesseract', [file, 'stdout'], { timeout: 45_000, maxBuffer: 8 << 20 });
    if (r2.err) {
      const msg = String(r2.stderr || r.stderr || r2.err.message || r.err.message || 'OCR failed').trim();
      return { ok: false, error: msg || 'Could not extract text from the image.', lang };
    }
    const text = String(r2.stdout || '').trim();
    return { ok: true, text, lang: 'default', available };
  }
  const text = String(r.stdout || '').trim();
  return { ok: true, text, lang, available };
}

export function screenAnswerText({ ocr, ocrEnabled = true } = {}) {
  if (!ocrEnabled) return '';
  if (!ocr) return 'OCR: not run.';
  if (!ocr.ok) return `OCR: ${ocr.error}`;
  if (!ocr.text) return `OCR (${ocr.lang || 'local'}): no readable text found in the image.`;
  return `OCR (${ocr.lang || 'local'}):\n${ocr.text}`;
}
