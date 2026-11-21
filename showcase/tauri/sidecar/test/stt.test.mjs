import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STT_MAX_SECONDS, STT_MODEL, languageTag, sttAccount, transcribe, transcribeRequest, transcriptOf, trimPcm, wav, wavSeconds } from '../stt.mjs';
import { languageOf } from '../lang.mjs';

console.log('gemini stt tests: start');

// ---- the WAV container ----
{
  const rate = 16000;
  const samples = new Float32Array(16000); // one second
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((i / rate) * 440) * 0.5;
  const buf = wav(samples, rate);
  assert.equal(buf.length, 44 + 32000);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.toString('ascii', 36, 40), 'data');
  assert.equal(buf.readUInt16LE(20), 1, 'PCM');
  assert.equal(buf.readUInt16LE(22), 1, 'mono');
  assert.equal(buf.readUInt32LE(24), rate);
  assert.equal(buf.readUInt16LE(34), 16, '16-bit');
  assert.equal(buf.readUInt32LE(40), 32000);
  assert.equal(wavSeconds(buf), 1);
  // Full scale does not wrap: a clip is louder, never a click into the opposite sign.
  const hot = wav(new Float32Array([2, -2, 0]));
  assert.equal(hot.readInt16LE(44), 32767);
  assert.equal(hot.readInt16LE(46), -32767);
  assert.equal(wavSeconds(Buffer.from('nope')), 0, 'a non-WAV is no duration at all');
}

// ---- trimming the silent ends ----
{
  const rate = 1000;
  const s = new Float32Array(4000); // 4 s, speech between 1 s and 2 s
  for (let i = 1000; i < 2000; i++) s[i] = 0.4;
  const t = trimPcm(s, rate, 0.012, 0.18);
  assert.ok(t.length > 1000 && t.length < 1400, `trimmed take keeps the words with a little air (${t.length})`);
  assert.ok(t.some((v) => Math.abs(v) > 0.3), 'and the words themselves');
  assert.equal(trimPcm(new Float32Array(4000), rate).length, 0, 'nothing above the threshold is nothing to send');
}

// ---- the request ----
{
  const audio = wav(new Float32Array(3200));
  const req = transcribeRequest(audio);
  assert.equal(req.model, STT_MODEL);
  assert.equal(req.input[0].type, 'audio');
  assert.equal(req.input[0].mime_type, 'audio/wav');
  assert.equal(req.input[0].data, audio.toString('base64'));
  assert.deepEqual(req.generation_config.transcription_config.language_codes, [],
    'no language hint, so the model identifies it (and code-switching survives)');
}

// ---- reading answers ----
{
  assert.equal(transcriptOf({ outputs: [{ type: 'text', text: 'Hello there.' }] }), 'Hello there.');
  assert.equal(transcriptOf({ output: { content: [{ text: '  spaced \n out  ' }] } }), 'spaced out');
  assert.equal(transcriptOf({ candidates: [{ content: { parts: [{ text: 'from candidates' }] } }] }), 'from candidates');
  assert.equal(transcriptOf({ transcript: 'short', outputs: [{ text: 'the whole sentence that was said out loud' }] }).length > 20, true,
    'the transcript wins over a shorter label');
  assert.equal(transcriptOf({}), '');
  assert.equal(transcriptOf(null), '');
}

// ---- the language the model heard ----
assert.equal(languageTag('ar-EG'), 'ar');
assert.equal(languageTag('ar'), 'ar');
assert.equal(languageTag('en-US'), 'en');
assert.equal(languageTag('Arabic'), 'ar');
assert.equal(languageTag('fr-FR'), null);
assert.equal(languageTag(''), null);
assert.equal(languageTag(null), null);

// ---- a whole transcription, against a fake Gemini ----
const fake = (status, body, onCall) => async (url, init) => {
  onCall?.(url, init);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
};
const take = wav(new Float32Array(16000).fill(0.3));
const noLogs = [];
const log = (k, v) => noLogs.push([k, v]);

// Arabic: the model says the language, and the text agrees.
{
  let seen = null;
  const r = await transcribe(take, {
    key: 'AIza-test', log,
    fetchImpl: fake(200, { outputs: [{ type: 'text', text: 'مرحبا، كيف حالك اليوم؟' }], language_code: 'ar-EG' }, (u, i) => { seen = { u, i }; }),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text, 'مرحبا، كيف حالك اليوم؟');
  assert.equal(r.language, 'ar');
  assert.equal(r.languages, 'ar');
  assert.match(seen.u, /generativelanguage\.googleapis\.com\/v1beta\/interactions$/);
  assert.equal(seen.i.headers['x-goog-api-key'], 'AIza-test');
  assert.equal(JSON.parse(seen.i.body).input[0].data, take.toString('base64'));
}

// English, and mixed Arabic/English: the letters decide when the answer names nothing.
{
  const r = await transcribe(take, { key: 'k', fetchImpl: fake(200, { text: 'Open the settings panel please.' }) });
  assert.equal(r.language, 'en');
  const m = await transcribe(take, { key: 'k', fetchImpl: fake(200, { text: 'افتح الـ settings panel من فضلك' }) });
  assert.equal(m.language, 'mixed');
  assert.equal(m.languages, languageOf('افتح الـ settings panel من فضلك'), 'the transcript is reported as it reads');
}

// Nothing heard, and what the failures say.
{
  const empty = await transcribe(take, { key: 'k', fetchImpl: fake(200, { outputs: [{ type: 'text', text: '   ' }] }) });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty');
  const key = await transcribe(take, { key: 'k', fetchImpl: fake(400, '{"error":{"message":"API key not valid"}}') });
  assert.equal(key.reason, 'key');
  const denied = await transcribe(take, { key: 'k', fetchImpl: fake(403, '{}') });
  assert.equal(denied.reason, 'key');
  const rate = await transcribe(take, { key: 'k', fetchImpl: fake(429, '{}') });
  assert.equal(rate.reason, 'rate');
  const err = await transcribe(take, { key: 'k', fetchImpl: fake(500, '{}') });
  assert.equal(err.reason, 'error');
  const offline = await transcribe(take, { key: 'k', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(offline.reason, 'network');
  const refused = await transcribe(take, { key: 'k', fetchImpl: fake(200, { error: { message: 'no' } }) });
  assert.equal(refused.ok, false);
  const noKey = await transcribe(take, { fetchImpl: fake(200, {}) });
  assert.equal(noKey.reason, 'key', 'no key is the key to report, before anything is sent');
  const tiny = await transcribe(Buffer.alloc(10), { key: 'k', fetchImpl: fake(200, {}) });
  assert.equal(tiny.reason, 'empty', 'a take with no audio in it never leaves the machine');
  const long = wav(new Float32Array((STT_MAX_SECONDS + 5) * 16000));
  const tooLong = await transcribe(long, { key: 'k', fetchImpl: fake(200, {}) });
  assert.equal(tooLong.reason, 'too_long');
}

// ---- what gets logged: sizes and words, never the key or the audio ----
{
  const all = JSON.stringify(noLogs);
  assert.ok(!all.includes('AIza-test'), 'the key is never in a log line');
  assert.ok(!all.includes(take.toString('base64').slice(0, 40)), 'nor is the audio');
  assert.ok(noLogs.every(([, v]) => v == null || typeof v === 'object'), 'log payloads are fields, not blobs');
}

// ---- a key check never throws ----
{
  assert.equal((await sttAccount('k', { fetchImpl: fake(200, {}) })).ok, true);
  assert.equal((await sttAccount('k', { fetchImpl: fake(400, {}) })).reason, 'key');
  assert.equal((await sttAccount('k', { fetchImpl: async () => { throw new Error('x'); } })).reason, 'network');
}

// ---- one Google key: hearing falls back to the Gemini voice's key ----
// A key saved for hearing wins, then the one saved for the Gemini voice, then the AI's Gemini key from the Model page.
{
  const src = readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('async function sttKey()');
  assert.ok(at > 0, 'sidekick has the hearing key lookup');
  const fn = src.slice(at, src.indexOf('const hearing =', at));
  assert.match(fn, /secrets\.get\(STT_KEY\)/, 'a key saved for hearing is read first');
  assert.match(fn, /voiceKey\('gemini'\)/, 'the Gemini voice key hears too');
  assert.ok(fn.indexOf('STT_KEY') < fn.indexOf("voiceKey('gemini')"), 'a hearing key of its own wins');
  assert.match(fn, /voiceKind === 'own' \? 'voice' : 'shared'/, 'the voice key is reported as such, not as the Model key');
}

console.log('gemini stt tests: all passed');
