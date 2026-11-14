// Arabic through the three voices that can speak: what each request carries, what is refused, and that one reply at a
// time is still all that plays. Fakes stand in for the network; nothing here needs a key or a sound card.
import assert from 'node:assert/strict';
import { GeminiVoice } from '../gemini.mjs';
import { FishVoice } from '../fish.mjs';
import { StudioVoice } from '../voicestudio.mjs';
import { createSpeaker } from '../speaker.mjs';
import { isArabic, languageOf } from '../lang.mjs';
import { encode, decode } from '../msgpack.mjs';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const audioEvent = (bytes) => `event: step.delta\ndata: ${JSON.stringify({ index: 0, delta: { mime_type: 'audio/l16', data: Buffer.from(bytes).toString('base64'), channels: 1, sample_rate: 24000, type: 'audio' }, event_type: 'step.delta' })}\n\n`;

{ // Gemini: no English style note on Arabic (no pace, no mood), the Arabic voice for it, English unchanged.
  const calls = [], errors = [], audio = [];
  const fetchImpl = async (url, init) => {
    const sent = JSON.parse(init.body);
    calls.push(sent);
    const pcm = sent.input[0].content[0].text.length; // any audio at all: each request must produce some
    return { ok: true, status: 200, body: (async function* () { yield Buffer.from(audioEvent([pcm, 0])); })() };
  };
  const v = new GeminiVoice({
    key: 'k', voice: 'Puck', fetchImpl, onAudio: (b) => audio.push(b), onEnd: () => {}, onError: (e) => errors.push(e),
    voiceFor: (t) => (isArabic(t) ? 'Sulafat' : null),
  });
  v.say('[excited] مرحبا بك!');
  v.say('Hello there.');
  v.end();
  await tick(20);
  assert.equal(errors.length, 0, errors.map((e) => e.message).join(', '));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input[0].content[0].text, 'مرحبا بك!');
  assert.equal('annotations' in calls[0].input[0].content[0], false, 'no English style or pace on Arabic');
  assert.equal(calls[0].generation_config.speech_config[0].voice, 'Sulafat', "the user's Arabic voice");
  assert.equal(calls[1].input[0].content[0].text, 'Hello there.');
  assert.equal(calls[1].input[0].content[0].annotations[0].style, 'speaking quickly', 'English keeps Gemini\'s pace fix');
  assert.equal(calls[1].generation_config.speech_config[0].voice, 'Puck');
}

// A fake Fish socket, as in fish.test.mjs.
class FakeWS {
  static last;
  constructor(url, opts) { this.url = url; this.opts = opts; this.sent = []; this.readyState = 0; FakeWS.last = this; }
  send(b) { this.sent.push(decode(b)); }
  close() { this.readyState = 3; this.closed = true; }
  open() { this.readyState = 1; this.onopen?.(); }
}
const fish = (opts = {}) => {
  const got = { audio: [], errors: [], ended: 0 };
  const v = new FishVoice({
    key: 'k', voice: 'look-voice', WebSocketImpl: FakeWS, onAudio: (a) => got.audio.push(a), onEnd: () => got.ended++, onError: (e) => got.errors.push(e),
    voiceFor: (t) => (isArabic(t) ? 'arabic-voice' : null), languageFor: (t) => (languageOf(t) === 'ar' ? 'ar' : null),
    ...opts,
  });
  return { v, got };
};
{ // A reply that starts in Arabic: the socket opens on that first sentence, with the Arabic voice and language tag.
  const { v } = fish();
  v.say('مرحبا بك.');
  const ws = FakeWS.last;
  assert.ok(ws, 'opening waits for the first sentence, so it can be in the right language');
  ws.open();
  const start = ws.sent.find((m) => m.event === 'start').request;
  assert.equal(start.reference_id, 'arabic-voice');
  assert.equal(start.language, 'ar', "Fish's numbers and dates are normalized per language");
}
{ // English (and mixed text, where Fish detects each chunk itself) sends no language.
  const { v } = fish();
  v.say('Hello there.');
  FakeWS.last.open();
  assert.equal('language' in FakeWS.last.sent.find((m) => m.event === 'start').request, false);
  const m = fish(); m.v.say('مرحبا, how are you?'); FakeWS.last.open();
  assert.equal('language' in FakeWS.last.sent.find((m) => m.event === 'start').request, false, 'mixed: detected per chunk');
}

// A fake VoiceStudio socket: one request per sentence, each with its own voice.
class FakeWS2 {
  static last;
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; FakeWS2.last = this; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
}
{ // VoiceStudio: the voice can follow each sentence's language.
  const v = new StudioVoice({ voice: null, WebSocketImpl: FakeWS2, onAudio: () => {}, onEnd: () => {}, onError: () => {}, voiceFor: (t) => (isArabic(t) ? 'ar-profile' : null) });
  v.open(); FakeWS2.last.open();
  v.say('مرحبا بك.');
  // One sentence at a time: VoiceStudio says "done" before the next is sent.
  FakeWS2.last.onmessage({ data: JSON.stringify({ type: 'start', sample_rate: 24000 }) });
  FakeWS2.last.onmessage({ data: JSON.stringify({ type: 'done' }) });
  v.say('Hello.');
  assert.deepEqual(FakeWS2.last.sent.map((m) => m.voice), ['ar-profile', undefined], 'no voice means the engine default');
  assert.deepEqual(FakeWS2.last.sent.map((m) => m.text), ['مرحبا بك.', 'Hello.']);
}

// The speaker: an engine that can't say Arabic is told once and the reply stays text (never another, paid service).
class FakeVoice {
  constructor(o) { Object.assign(this, o); this.said = []; FakeVoice.last = this; }
  open() { return this; }
  say(s) { this.said.push(s); }
  end() {}
  abort() { this.aborted = true; }
}
class FakeLocal {
  constructor(o) { Object.assign(this, o); this.said = []; FakeLocal.all.push(this); }
  open() { return this; }
  say(s) { this.said.push(s); this.onAudio?.(new Uint8Array([1, 0]), 24000); }
  end() { this.ended = true; }
  abort() { this.aborted = true; }
}
FakeLocal.all = [];
const local = async (engine, out = [], problems = []) => {
  FakeLocal.all = [];
  const sp = createSpeaker({
    emit: (m) => out.push(m), onProblem: (p) => problems.push(p), FishVoiceImpl: FakeVoice, account: async () => ({ ok: true, credit: 1 }),
    beatPhrases: [], bundled: () => null, LocalVoiceImpl: FakeLocal,
    localStatus: async () => ({ ok: true, reason: null, engine, engineName: engine, voices: [{ id: 'ar-profile', name: 'Arabic' }] }),
  });
  sp.setProvider('voicestudio');
  await tick();
  return sp;
};
{ // KittenTTS is English-only: Arabic isn't sent, and the reason names the engine and the fix.
  const out = [], problems = [];
  const sp = await local('KittenTTS', out, problems);
  sp.start().say('مرحبا بك.');
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /KittenTTS/);
  assert.match(problems[0].message, /OmniVoice/);
  assert.deepEqual(FakeLocal.all.at(-1).said, [], 'nothing garbled was spoken');
  assert.equal(out.some((m) => m.kind === 'speech' && m.pcm), false);
  assert.equal(sp.arabic().arabic, false);
}
{ // OmniVoice speaks Arabic: it's sent, in the user's Arabic voice, and English keeps the default.
  const out = [], problems = [];
  const sp = await local('OmniVoice', out, problems);
  sp.setLangVoices({ ar: 'ar-profile' });
  const r = sp.start();
  r.say('مرحبا بك.');
  r.say('Hello.');
  const inst = FakeLocal.all.at(-1);
  assert.deepEqual(problems, []);
  assert.deepEqual(inst.said, ['مرحبا بك.', 'Hello.']);
  assert.equal(inst.voiceFor('مرحبا'), 'ar-profile', 'the Arabic sentence uses the Arabic voice');
  assert.equal(inst.voiceFor('Hello.'), null, 'English falls back to the engine default');
  assert.equal(out.filter((m) => m.kind === 'speech' && m.pcm).length, 2);
  assert.equal(sp.arabic().arabic, true);
}
{ // A second reply stops the first: no two voices ever play over each other, in any service.
  const out = [];
  const sp = await local('OmniVoice', out);
  const a = sp.start(); a.say('مرحبا.');
  const b = sp.start(); b.say('Hello.');
  assert.ok(FakeLocal.all[0].aborted, 'the first reply is cut off');
  // What A played before B existed is history; nothing of A's can play after B started.
  out.length = 0;
  a.say('وحتى الآن.');
  assert.deepEqual(out, [], "the old reply is silent once it's stopped");
  b.say('More.');
  assert.ok(out.every((m) => m.id === b.id), 'only the new reply speaks');
}
{ // Stopping mid-Arabic is silent and final (nothing is spoken after an abort).
  const out = [], problems = [];
  const sp = await local('OmniVoice', out, problems);
  const r = sp.start(); r.say('مرحبا بك.');
  r.abort();
  r.say('وحتى الآن.');
  assert.deepEqual(problems, []);
  assert.equal(FakeLocal.all.at(-1).said.length, 1, 'nothing was said after the abort');
}
console.log('arabic voice tests: passed');
