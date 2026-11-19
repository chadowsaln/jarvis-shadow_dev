#!/usr/bin/env node
// Hearing through Gemini, end to end, with a real key: two short takes — one Arabic, one English — are sent the way
// the sidecar sends them (the take as a 16 kHz mono WAV, no language hint) and the answer is printed as the words and
// the language that came back. This is the live check for stt.mjs: `npm test` covers the request, the reading of the
// answer and the language rule offline; this tells you whether Google agrees today, and with your key.
//
//   GEMINI_API_KEY=... node test/hear-smoke.mjs hello-ar.wav hello-en.wav
//   node test/hear-smoke.mjs --key ... --ar hello-ar.wav --en hello-en.wav [--model gemini-3.5-transcribe]
//   node test/hear-smoke.mjs --mock        # no key, no network: the pipeline against a canned answer (what CI runs)
//
// The exits: 0 both takes came back in the language they were spoken in, 1 one didn't, 2 usage or key. Nothing here
// prints the key, the samples or anything but the words.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GEMINI_API } from '../gemini.mjs';
import { STT_MODEL, transcribe, sttAccount, trimPcm, wav, wavSeconds } from '../stt.mjs';

/**
 * What a WAV actually is, for the line above its transcript. The chunks are walked rather than assumed at fixed
 * offsets: a recording out of Audacity or QuickTime carries a LIST/INFO chunk before the audio, and reading the
 * header at 44 would then describe (and trim) the metadata instead of the sound.
 */
export function describeWav(buf) {
  if (!buf || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return { ok: false, why: 'not a RIFF/WAV file' };
  let fmt = null, data = null;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('ascii', p, p + 4), size = buf.readUInt32LE(p + 4), body = p + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size || buf.length - body, buf.length - body) }; // 0 = to the end
      break;
    }
    if (size > buf.length - body) break; // a broken size would walk off the end
    p = body + size + (size % 2);
  }
  if (!fmt) return { ok: false, why: 'no fmt chunk' };
  if (!data || data.size <= 0) return { ok: false, why: 'no audio data' };
  const { format, channels, rate, bits } = fmt;
  const seconds = data.size / (channels * (bits / 8 || 1) * (rate || 1));
  // Gemini takes what the helper produces. Anything else usually still transcribes, but the point of a smoke test is
  // to send the real thing, so a mismatch is said out loud rather than hidden.
  const why = format !== 1 ? 'not uncompressed PCM' : channels !== 1 ? `${channels} channels, not mono` : bits !== 16 ? `${bits}-bit, not 16` : rate !== 16000 ? `${rate} Hz, not 16 kHz` : null;
  return { ok: true, why, seconds, rate, channels, bits, offset: data.offset, size: data.size };
}

/** Does a result answer the language it was spoken in? 'mixed' is allowed — the model hearing a word or two in the
 *  other language is the code-switching this provider exists for — but the wrong language is not. */
export const verdict = (expected, got) => (got === expected ? 'ok' : got === 'mixed' ? 'ok (mixed)' : 'wrong');

/**
 * Runs the takes through the same call the sidecar makes. Never throws: one bad take doesn't hide the other one's
 * result. `files` is [{ path, label, expected }] (or [{ bytes, ... }] for the mock), `say` receives each line.
 */
export async function run({ files, key, model = STT_MODEL, fetchImpl = fetch, say = console.log, trim = true, mock = false }) {
  const out = [];
  say(`Gemini hearing: ${model}`);
  if (!mock && key) {
    const who = await sttAccount(key, { fetchImpl });
    say(`key: ${who.ok ? 'ok' : `refused (${who.reason})`}`);
    if (!who.ok && who.reason === 'key') return { pass: 0, fail: files.length, results: out, fatal: 'key' };
  } else {
    say('key: not needed (mock)');
  }
  for (const f of files) {
    let bytes = f.bytes;
    if (!bytes) {
      try { bytes = readFileSync(f.path); } catch (e) {
        say(`${f.label} ${basename(f.path)}: cannot read it (${e.code ?? e.message})`);
        out.push({ ...f, ok: false, reason: 'unreadable' });
        continue;
      }
    }
    const info = describeWav(bytes);
    const name = f.path ? basename(f.path) : `${f.label} (generated)`;
    if (!info.ok) {
      say(`${f.label} ${name}: ${info.why}`);
      out.push({ ...f, ok: false, reason: 'audio' });
      continue;
    }
    // The sidecar trims the silent ends before sending; a fixture recorded with a long lead-in would otherwise be a
    // test of the trimmer, not of the transcription.
    if (trim && info.why == null) {
      const pcm = Buffer.from(bytes.subarray(info.offset, info.offset + info.size));
      const samples = new Float32Array(pcm.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
      const kept = trimPcm(samples, info.rate);
      if (kept.length && kept.length < samples.length) {
        bytes = wav(kept, info.rate);
        info.seconds = wavSeconds(bytes);
      }
    }
    const r = await transcribe(bytes, { key: key ?? 'mock', model, fetchImpl });
    const v = r.ok ? verdict(f.expected, r.language ?? r.languages) : 'wrong';
    const head = `${f.label} ${name}  ${info.seconds.toFixed(1)} s${info.why ? `  (${info.why})` : ''}`;
    if (r.ok) {
      say(`${head}  ${r.ms} ms`);
      say(`  heard (${r.language ?? '?'}; the letters read ${r.languages}): ${r.text}`);
      say(`  expected ${f.expected}: ${v}`);
    } else {
      say(`${head}  failed: ${r.reason}${r.message ? ` — ${r.message}` : ''}`);
    }
    out.push({ ...f, ...r, ok: r.ok && v !== 'wrong', verdict: v });
  }
  const pass = out.filter((r) => r.ok).length;
  const fail = out.length - pass;
  say(`${pass} of ${out.length} passed${fail ? `, ${fail} failed` : ''}`);
  return { pass, fail, results: out, fatal: null };
}

// ---- the mock: the real pipeline, a canned answer ----
// Two one-second tones stand in for the takes (they are never sent), and the fetch answers in the transcription
// API's own envelope. This is what a CI run can check: that the request is built, sent to the right endpoint with the
// key in its own header, and that the words and languages are read back and judged.
export function mockFetch(answers = [
  { output: [{ type: 'transcript', language_code: 'ar', text: 'مرحبا، كيف حالك اليوم؟' }] },
  { output: [{ type: 'transcript', language_code: 'en', text: 'Hello, how are you doing today?' }] },
]) {
  const seen = [];
  let i = 0;
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, headers: init.headers ?? {}, body: init.body });
    const answer = answers[Math.min(i++, answers.length - 1)];
    return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  return { fetchImpl, seen };
}

/** Seconds of a quiet tone: only its WAV header matters here, but a real PCM body keeps the size checks honest. */
export const tone = (seconds = 1) => {
  const a = new Float32Array(16000 * seconds);
  for (let i = 0; i < a.length; i++) a[i] = Math.sin(i / 8) * 0.2;
  return a;
};

// ---- the command line ----
const USAGE = `usage: GEMINI_API_KEY=... node test/hear-smoke.mjs <arabic.wav> <english.wav>
       node test/hear-smoke.mjs --ar <arabic.wav> --en <english.wav> [--key <key>] [--model <id>]
       node test/hear-smoke.mjs --mock`;

function argv(list) {
  const o = { files: [], mock: false, key: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? null, model: STT_MODEL, help: false };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--mock') o.mock = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--key') o.key = list[++i] ?? null;
    else if (a === '--model') o.model = list[++i] ?? STT_MODEL;
    else if (a === '--ar' || a === '--en') o.files.push({ label: a.slice(2), expected: a.slice(2), path: list[++i] ?? '' });
    else o.files.push({ label: o.files.length === 0 ? 'ar' : 'en', expected: o.files.length === 0 ? 'ar' : 'en', path: a });
  }
  return o;
}

async function main(list) {
  const o = argv(list);
  if (o.help) { console.log(USAGE); return 0; }
  if (o.mock) {
    // Two takes, canned answers: the same code path as a live run, minus the network.
    const { fetchImpl, seen } = mockFetch();
    const files = [
      { label: 'ar', expected: 'ar', bytes: wav(tone()) },
      { label: 'en', expected: 'en', bytes: wav(tone()) },
    ];
    const r = await run({ files, key: 'mock', model: 'mock-transcribe', fetchImpl, mock: true });
    const url = seen[0]?.url ?? '';
    const ok = r.fail === 0 && url === `${GEMINI_API}/interactions` && seen.every((s) => (s.headers['x-goog-api-key'] ?? '') === 'mock');
    console.log(ok ? 'mock: the request and the reading agree' : `mock: unexpected request (${url})`);
    return ok ? 0 : 1;
  }
  if (!o.key) { console.error('No key: set GEMINI_API_KEY or pass --key.\n\n' + USAGE); return 2; }
  if (o.files.length !== 2 || o.files.some((f) => !f.path)) { console.error(USAGE); return 2; }
  const r = await run({ files: o.files, key: o.key, model: o.model });
  return r.fatal === 'key' ? 2 : r.fail ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
}
