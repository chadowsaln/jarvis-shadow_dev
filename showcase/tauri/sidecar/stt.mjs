// Hearing, through Gemini: the take's audio is transcribed by Google's transcription model, which identifies the
// language itself (Arabic, English, and the two mixed in one sentence) instead of being told which one to expect.
// The on-device models (Apple Speech on macOS, Parakeet on Windows and Linux) stay the default and the fallback:
// this is one provider behind the same interface, chosen by the user, and a failure here leaves the take's own
// transcript standing rather than losing what was said.
//
// The audio is the take exactly as the microphone heard it (16 kHz mono PCM in a WAV container, silence trimmed at
// both ends by the helper); only a size and a duration are ever logged, never the samples and never the key.
import { GEMINI_API } from './gemini.mjs';
import { languageOf } from './lang.mjs';

// Google's dedicated speech-to-text model (ai.google.dev/gemini-api/docs/transcribe, Nov 2026): 1 hour per request,
// automatic language identification, code-switching. There's one to pick from for now; the list is what the panel
// shows, so a second model is a one-line change here.
export const STT_MODEL = 'gemini-3.5-transcribe';
export const STT_MODELS = [{ id: STT_MODEL, name: 'Gemini Transcribe' }];
// A take is at most a minute (the helper's own session cap); past this the audio is cut, so nothing unbounded is
// ever sent.
export const STT_MAX_SECONDS = 90;
export const STT_RATE = 16000;

/** 16-bit mono PCM in a WAV container: the smallest thing every speech API accepts. */
export function wav(samples, rate = STT_RATE) {
  const n = samples.length;
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + n * 2, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);          // the fmt chunk's size
  out.writeUInt16LE(1, 20);           // PCM
  out.writeUInt16LE(1, 22);           // mono
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);    // bytes a second
  out.writeUInt16LE(2, 32);           // bytes a frame
  out.writeUInt16LE(16, 34);          // bits a sample
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return out;
}

/**
 * The take without its silent ends (a little kept either side). Speech models invent words from a long silence, and
 * a take starts before the chord's own click and ends after the last word.
 */
export function trimPcm(samples, rate = STT_RATE, threshold = 0.012, keep = 0.18) {
  const loud = (v) => Math.abs(v) >= threshold;
  let a = 0, b = samples.length - 1;
  while (a <= b && !loud(samples[a])) a++;
  if (a > b) return new Float32Array(0); // nothing above the threshold: left to the caller to report
  while (b > a && !loud(samples[b])) b--;
  const pad = Math.round(rate * keep);
  return samples.slice(Math.max(0, a - pad), Math.min(samples.length, b + 1 + pad));
}

/** Seconds of audio in a 16-bit mono WAV (0 when it isn't one). */
export function wavSeconds(buf) {
  if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return 0;
  const rate = buf.readUInt32LE(24), bytes = buf.readUInt32LE(40);
  return rate ? bytes / 2 / rate : 0;
}

const b64 = (buf) => Buffer.from(buf).toString('base64');

// ---- reading the answer ----
// The transcription API's envelope is new and may gain fields; what matters is the words. Every place a text answer
// has been seen is looked at, in order, and the first non-empty one wins. Nothing here guesses at semantics: it
// reads strings the response actually carries.
const TEXT_KEYS = new Set(['text', 'transcript', 'transcription', 'content', 'output_text']);
function pickText(node, depth = 0, out = []) {
  if (node == null || depth > 6) return out;
  if (typeof node === 'string') return out;
  if (Array.isArray(node)) {
    for (const v of node) pickText(v, depth + 1, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && TEXT_KEYS.has(k.toLowerCase()) && v.trim()) out.push(v);
    else if (v && typeof v === 'object') pickText(v, depth + 1, out);
  }
  return out;
}
/** The plain text of a response: its longest text field (a transcript, not a caption or a status line). */
export function transcriptOf(json) {
  const all = pickText(json)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s && s.length <= 8000 && !/^data:/i.test(s));
  if (!all.length) return '';
  return all.sort((a, b) => b.length - a.length)[0];
}

const TAG = { ar: 'ar', en: 'en' };
/** 'ar' / 'en' for a language the model named (a BCP-47 tag or a name), else null. */
export function languageTag(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim().toLowerCase().replace('_', '-');
  if (s.startsWith('ar')) return TAG.ar;
  if (s.startsWith('en')) return TAG.en;
  if (s === 'arabic') return TAG.ar;
  if (s === 'english') return TAG.en;
  return null;
}
// Where a model puts the language it heard: any of these, at any reasonable depth.
function findLanguage(node, depth = 0) {
  if (node == null || depth > 5) return null;
  if (Array.isArray(node)) {
    for (const v of node) { const l = findLanguage(v, depth + 1); if (l) return l; }
    return null;
  }
  if (typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    const key = k.toLowerCase();
    if ((key === 'language_code' || key === 'language' || key === 'detected_language' || key === 'lang') && typeof v === 'string') {
      const l = languageTag(v);
      if (l) return l;
    }
    if (v && typeof v === 'object') { const l = findLanguage(v, depth + 1); if (l) return l; }
  }
  return null;
}

/**
 * The request the Interactions API takes for a transcription. Automatic language identification is the default;
 * an empty list states it, which is what makes code-switching work (no hint to fight).
 */
export const transcribeRequest = (audio, { model = STT_MODEL, mime = 'audio/wav', hints = [] } = {}) => ({
  model,
  input: [{ type: 'audio', data: b64(audio), mime_type: mime }],
  generation_config: { transcription_config: { language_codes: hints } },
});

const reasonFor = (status) => (status === 429 ? 'rate' : status === 400 || status === 401 || status === 403 ? 'key' : 'error');

/**
 * Transcribes one take. Never throws.
 *   audio: Buffer/Uint8Array (WAV) or a base64 string of one
 * Returns { ok: true, text, language, languages, ms, bytes } or { ok: false, reason, message, ms }.
 *   reason: 'key' (bad or missing), 'rate', 'network', 'empty' (nothing was said), 'too_long', 'error'
 * `language` is 'ar', 'en' or 'mixed', read from the model's own answer when it names one and from the letters of
 * the transcript otherwise; `languages` always says what the transcript itself reads as.
 */
export async function transcribe(audio, { key, model = STT_MODEL, mime = 'audio/wav', hints = [], fetchImpl = fetch, timeout = 45_000, signal = null, log = () => {} } = {}) {
  const t0 = Date.now();
  const done = (r) => ({ ...r, ms: Date.now() - t0 });
  if (!key) return done({ ok: false, reason: 'key', message: 'No Gemini key is saved.' });
  let bytes;
  try {
    bytes = typeof audio === 'string' ? Buffer.from(audio, 'base64') : Buffer.from(audio ?? []);
  } catch {
    return done({ ok: false, reason: 'error', message: 'The take could not be read.' });
  }
  if (bytes.length <= 44) return done({ ok: false, reason: 'empty', message: 'Nothing was recorded.' });
  const seconds = wavSeconds(bytes);
  if (seconds > STT_MAX_SECONDS) return done({ ok: false, reason: 'too_long', message: `That take is ${Math.round(seconds)} seconds; the limit is ${STT_MAX_SECONDS}.` });

  const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  let r;
  try {
    r = await fetchImpl(`${GEMINI_API}/interactions`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(transcribeRequest(bytes, { model, mime, hints })),
      signal: stop,
    });
  } catch (e) {
    if (e?.name === 'AbortError' && signal?.aborted) return done({ ok: false, reason: 'cancelled', message: 'Stopped.' });
    log('stt_error', { reason: 'network', bytes: bytes.length });
    return done({ ok: false, reason: 'network', message: e?.name === 'TimeoutError' ? 'Gemini took too long to answer.' : 'Could not reach Gemini.' });
  }
  if (!r.ok) {
    // A bad key is a 400 here ("API_KEY_INVALID"); 403 is a key without the API enabled. Neither says anything
    // about the audio, so the reason stays the key's.
    const said = await r.text().catch(() => '');
    const message = said.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1] ?? `Gemini error ${r.status}`;
    log('stt_error', { reason: reasonFor(r.status), status: r.status, bytes: bytes.length });
    return done({ ok: false, reason: reasonFor(r.status), message });
  }
  let json;
  try { json = await r.json(); } catch { return done({ ok: false, reason: 'error', message: 'Gemini sent an answer that could not be read.' }); }
  if (json?.error) return done({ ok: false, reason: reasonFor(json.error.code === 429 ? 429 : 400), message: json.error.message ?? 'Gemini refused the take.' });

  const text = transcriptOf(json);
  const letters = languageOf(text);
  if (!text) {
    log('stt_empty', { bytes: bytes.length, seconds: Math.round(seconds * 10) / 10 });
    return done({ ok: false, reason: 'empty', message: "I didn't catch any words." });
  }
  const language = findLanguage(json) && letters !== 'mixed' ? findLanguage(json) : letters ?? null;
  log('stt_done', { ms: Date.now() - t0, bytes: bytes.length, seconds: Math.round(seconds * 10) / 10, language, chars: text.length });
  return done({ ok: true, text, language, languages: letters, bytes: bytes.length, seconds });
}

/** Is the key good? Never throws: { ok, reason } in the same words as the voice's own check. */
export async function sttAccount(key, { fetchImpl = fetch, timeout = 6000 } = {}) {
  try {
    const r = await fetchImpl(`${GEMINI_API}/models?pageSize=1`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(timeout) });
    if (r.status === 400 || r.status === 401 || r.status === 403) return { ok: false, reason: 'key' };
    if (!r.ok) return { ok: false, reason: 'network' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'network' };
  }
}
