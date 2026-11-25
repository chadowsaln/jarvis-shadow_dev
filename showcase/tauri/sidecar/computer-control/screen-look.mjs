// Screen awareness & visual targeting (Batch 4).
// Combines AT-SPI accessibility search with OCR fallback and screen diffing.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { captureViaPortal, ocrImage, removeTemp } from '../screen.mjs';

/** Computes a quick sha256 hash of a file or buffer to detect changes. */
export async function computeScreenHash(fileOrBuffer) {
  const buf = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : await fs.readFile(fileOrBuffer);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Compare two screen hashes or buffers. Returns { changed: boolean, similarity: number }. */
export function screenDiff(hashA, hashB) {
  if (!hashA || !hashB) return { changed: true, similarity: 0 };
  const same = String(hashA) === String(hashB);
  return {
    changed: !same,
    similarity: same ? 1.0 : 0.0,
  };
}

/**
 * Hierarchical element search:
 *  1. AT-SPI Accessibility (free, fast, exact bounds).
 *  2. Local OCR on the screenshot (when accessibility gives nothing, e.g. canvas/web).
 * Returns { found: boolean, source: 'atspi' | 'ocr' | 'none', element: object | null, center: [x, y] | null }.
 */
export async function findElementHierarchy(query, { atspiDriver = null, screenshotFile = null, preferredLangs = ['ara', 'eng'] } = {}) {
  const q = String(query || '').trim();
  if (!q) return { found: false, source: 'none', element: null, center: null };

  // Strategy 1: AT-SPI Accessibility
  if (atspiDriver) {
    try {
      const candidates = await atspiDriver.findElements({ name: q });
      if (candidates && candidates.length > 0) {
        const best = candidates[0];
        const c = best.coordinates;
        const center = c && c.width > 0 && c.height > 0 ? [c.x + Math.round(c.width / 2), c.y + Math.round(c.height / 2)] : null;
        return {
          found: true,
          source: 'atspi',
          element: {
            name: best.name,
            role: best.role,
            description: best.description,
            states: best.states,
            bounds: c || null,
          },
          center,
        };
      }
    } catch {
      // Fall through to OCR
    }
  }

  // Strategy 2: Local OCR on screenshot
  if (screenshotFile) {
    try {
      const ocrRes = await ocrImage(screenshotFile, { preferred: preferredLangs });
      if (ocrRes.ok && ocrRes.text) {
        const lowerText = ocrRes.text.toLowerCase();
        const lowerQ = q.toLowerCase();
        if (lowerText.includes(lowerQ)) {
          // Found matching text in the OCR extraction
          return {
            found: true,
            source: 'ocr',
            element: {
              textMatch: q,
              engine: ocrRes.engine || 'tesseract',
              snippet: ocrRes.text.slice(0, 300),
            },
            center: null,
          };
        }
      }
    } catch {
      // OCR error/unavailable
    }
  }

  return { found: false, source: 'none', element: null, center: null };
}

/**
 * ScreenLook controller with caching: captures screen/window, diffs with previous capture,
 * and searches for targets hierarchy-first.
 */
export function createScreenLook({ askShell, createATSPIDriver } = {}) {
  let lastShot = null; // { file, hash, at, pixels, bounds }

  return {
    getLastShot() {
      return lastShot;
    },
    invalidateCache() {
      lastShot = null;
    },
    async look({ target = 'screen', query = null, forceFresh = false, runOcr = true } = {}) {
      const now = Date.now();
      // Reuse cache if fresh (<2.5s) and not forced
      if (!forceFresh && lastShot && (now - lastShot.at < 2500) && !query) {
        return {
          ok: true,
          cached: true,
          changed: false,
          file: lastShot.file,
          bounds: lastShot.bounds,
          pixels: lastShot.pixels,
        };
      }

      // Capture fresh screenshot
      const cap = await captureViaPortal({ askShell, interactive: false });
      if (!cap.ok) {
        return { ok: false, error: cap.error };
      }

      const hash = await computeScreenHash(cap.file).catch(() => null);
      const diff = lastShot ? screenDiff(lastShot.hash, hash) : { changed: true, similarity: 0 };

      // Invalidate old temp file
      if (lastShot?.file && lastShot.file !== cap.file) {
        await removeTemp(lastShot.file);
      }

      lastShot = {
        file: cap.file,
        hash,
        at: now,
        pixels: cap.pixels,
        bounds: cap.bounds,
      };

      let searchResult = null;
      if (query) {
        let driver = null;
        if (typeof createATSPIDriver === 'function') {
          try { driver = await createATSPIDriver(); } catch {}
        }
        try {
          searchResult = await findElementHierarchy(query, {
            atspiDriver: driver,
            screenshotFile: cap.file,
          });
        } finally {
          if (driver) await driver.disconnect().catch(() => {});
        }
      }

      return {
        ok: true,
        cached: false,
        changed: diff.changed,
        similarity: diff.similarity,
        file: cap.file,
        pixels: cap.pixels,
        bounds: cap.bounds,
        target,
        queryMatch: searchResult,
      };
    },
  };
}
