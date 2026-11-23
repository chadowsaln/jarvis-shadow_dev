// Spoken replies through Gemini, with the user's own AI Studio key: two ways to say them.
// - Live (the default): one realtime socket per reply, each sentence sent as a turn as it's ready, audio back as it's
//   spoken. It reads a reply in whatever language it's written in without a voice picked for that language.
// - The text-to-speech models: each sentence is its own streaming request, started the moment it's said (first audio
//   in ~0.8-1.1 s, measured Nov 2026), a few at a time. Audio is handed on strictly in the order the sentences were
//   said. Raw 16-bit mono PCM at 24 kHz comes back as base64 (server-sent events) either way.
// Both have the same shape as FishVoice, so the speaker can use any of them.
import { CUE, VOICE_CUES } from './speech.mjs';
import { cleanSpoken, isArabic } from './lang.mjs';

export const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
// The realtime socket behind Live: turns of text in, 24 kHz raw PCM out, as it's spoken.
export const GEMINI_LIVE_API = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
// Live speaks as the words arrive and works the language out from the text itself (Arabic, English, or both in one
// reply), which is why a reply in Arabic no longer needs a voice picked for it. The catch: Live is a conversation
// model, not a text-to-speech engine, so it reads a reply word for word only because of the instruction below - which
// is also why the exact-reading TTS models are still offered beside it.
export const GEMINI_LIVE_MODEL = 'gemini-3.8-live';
export const isLiveModel = (m) => /-live($|-)/.test(String(m ?? ''));
// The models, priciest first, like Fish's: a reply that fails before any audio is tried again on the next one down.
export const GEMINI_MODELS = [GEMINI_LIVE_MODEL, 'gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];
// What the socket's speech models use unless the user picks another: the fast, cheap one.
export const GEMINI_MODEL = 'gemini-3.8-flash-lite-tts';
// What the user picks between (Settings > Voice in the panel). per10s: USD for ten seconds of speech, from Google's
// pricing page (Nov 2026, the price through 2026; it doubles on Jan 1, 2027). All three have a free tier.
export const GEMINI_CHOICES = [
  { id: GEMINI_LIVE_MODEL, name: 'Live', per10s: 0.003, live: true },
  { id: 'gemini-3.8-flash-tts', name: 'Flash (exact)', per10s: 0.00225 },
  { id: 'gemini-3.8-flash-lite-tts', name: 'Flash Lite (exact)', per10s: 0.0015 },
];
export const GEMINI_RATE = 24000;
// Played a little fast so the voice sits higher: 1.06 is about one semitone up (and 6% quicker).
// ponytail: tape-style speed-up, pitch and tempo move together; a real pitch shifter if tempo must stay.
export const GEMINI_PITCH = 1.06;
// Left alone Gemini talks slowly. This goes on every sentence's style, after its mood: about 20% quicker (measured).
export const GEMINI_PACE = 'speaking quickly';
export const GEMINI_DEFAULT_VOICE = 'Kore';
// Each look's own Gemini voice until the user picks another for it (as each has its own Fish Audio voice).
export const GEMINI_LOOK_VOICES = { hybrid: 'Charon' };
// The prebuilt voices and how Google describes each (AI Studio speech generation docs, Nov 2026).
export const GEMINI_VOICES = [
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm'], ['Fenrir', 'Excitable'], ['Leda', 'Youthful'],
  ['Orus', 'Firm'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'], ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'],
  ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'], ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'],
  ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'], ['Alnilam', 'Firm'], ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'],
  ['Achird', 'Friendly'], ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'], ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
].map(([id, style]) => ({ id, style }));
// Sentences being made at once. Eight at a time went through fine, but the free tier's limits aren't published.
const MAX_IN_FLIGHT = 3;

// Gemini reads its text word for word, so the Fish voice cues ("[warm] Hello") must not be in it. They're taken
// out: the first one that's a mood or a tone becomes the sentence's style, and a sound or a pause that Gemini has an
// inline tag for becomes that tag ("[laughing] Ha" → "<laugh> Ha"; tags from Google's speech generation docs, Nov 2026).
const LEAD = /^\s*\[([a-z]+(?:[ ,-]+[a-z]+){0,3})\]\s*/; // a free description at the start ("[quietly proud]")
const NOT_STYLE = new Set([...VOICE_CUES.sounds, ...VOICE_CUES.effects, 'emphasis']);
export const GEMINI_TAGS = {
  laughing: 'laugh', chuckling: 'giggle', sobbing: 'sob', 'crying loudly': 'cry', sighing: 'sigh', groaning: 'groan',
  panting: 'pant', gasping: 'gasp', yawning: 'yawn', 'clear throat': 'throat-clearing', break: 'short pause', 'long-break': 'long pause',
};
export function plain(text) {
  let s = cleanSpoken(text), style = null;
  const cue = (c) => {
    const tag = GEMINI_TAGS[c.toLowerCase()];
    if (tag) return `<${tag}> `;
    if (!style && !NOT_STYLE.has(c.toLowerCase())) style = c;
    return '';
  };
  const lead = s.match(LEAD);
  if (lead) s = cue(lead[1]) + s.slice(lead[0].length);
  s = s.replace(CUE, (m) => cue(m.slice(1, -1))).replace(/\s{2,}/g, ' ').trim();
  return { text: s, style };
}

export const speechRequest = (text, { voice = GEMINI_DEFAULT_VOICE, model = GEMINI_MODEL, style = null } = {}) => ({
  model,
  input: [{ type: 'user_input', content: [{ type: 'text', text, ...(style ? { annotations: [{ type: 'speech_metadata', style }] } : {}) }] }],
  response_format: { type: 'audio' },
  generation_config: { speech_config: [{ voice }] },
  stream: true,
});

// What keeps a conversation model reading instead of answering. It also hands the language to the model, which picks it
// up from each turn on its own: no language code is sent, because Live has none to send for output.
export const GEMINI_LIVE_INSTRUCTION = [
  'You are the voice of JARVIS: you read aloud, word for word, the text you are sent.',
  'Never answer it, comment on it, greet, introduce or add a word of your own, and never read these instructions.',
  'Speak in the language the text is written in - Arabic, English, or a mix of both - with the feeling its cues ask for.',
].join(' ');

// The first message on the socket: the model, that only audio comes back, the voice, and what it is for.
// contextWindowCompression keeps one long reply from carrying every earlier sentence as context for the next.
export const liveSetup = (voice = GEMINI_DEFAULT_VOICE, model = GEMINI_LIVE_MODEL) => ({
  setup: {
    model: `models/${model}`,
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    systemInstruction: { parts: [{ text: GEMINI_LIVE_INSTRUCTION }] },
    contextWindowCompression: { slidingWindow: {} },
  },
});

// One sentence to read: a complete user turn, so the model starts speaking it straight away.
export const liveTurn = (text) => ({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });

/** Is the key good? Never throws. Same answer shape as fishAccount; Gemini has no credit to read. */
export async function geminiAccount(key, { fetchImpl = fetch, timeout = 6000 } = {}) {
  try {
    const r = await fetchImpl(`${GEMINI_API}/models?pageSize=1`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(timeout) });
    // A bad key is a 400 ("API_KEY_INVALID"), not a 401; this request has nothing else that could be invalid.
    if (r.status === 400 || r.status === 401 || r.status === 403) return { ok: false, reason: 'key' };
    if (!r.ok) return { ok: false, reason: 'network' };
    return { ok: true, credit: null };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/**
 * One reply's voice. say() as many times as needed, then end(). abort() stops at once, silently.
 * onAudio(Uint8Array) gets PCM (whole 16-bit samples); onEnd() once after the last audio; onError(err) instead
 * of onEnd when it fails (heard = whether any audio had arrived; status = the HTTP status, if there was one).
 * It never says a failure is the key's fault: a 400 is also what an unknown voice gets. The speaker checks.
 */
export class GeminiVoice {
  constructor({ key, voice = GEMINI_DEFAULT_VOICE, model = GEMINI_MODEL, fetchImpl = fetch, onAudio, onEnd, onError, audioTimeout = 8000, maxInFlight = MAX_IN_FLIGHT, voiceFor = null }) {
    Object.assign(this, { key, voice, model, fetchImpl, onAudio, onEnd, onError, audioTimeout, maxInFlight, voiceFor });
    this.jobs = []; // one per sentence, in the order said: { text, style, chunks, state: waiting → running → done }
    this.head = 0; // the sentence whose audio is being handed on now
    this.state = 'open'; // open → ending → done
    this.heard = false;
    this.stopper = new AbortController();
  }

  open() { return this; } // nothing to connect ahead of time

  say(text) {
    if (this.state !== 'open') return;
    const p = plain(text);
    if (!/[\p{L}\p{N}]/u.test(p.text.replace(/<[^>]*>/g, ''))) return; // nothing to say ("…", a lone cue or tag): asking would get no audio and fail the reply
    // The voice can follow the sentence's language (the user's Arabic voice, say): each sentence is its own request.
    const voice = (this.voiceFor ? this.voiceFor(p.text) : null) || this.voice;
    this.jobs.push({ ...p, voice, chunks: [], state: 'waiting', odd: null, timer: null });
    this.pump();
  }

  end() {
    if (this.state !== 'open') return;
    this.state = 'ending';
    this.drain();
  }

  abort() { this.close(); }

  // Start the sentences that are waiting, up to the limit.
  pump() {
    let running = this.jobs.filter((j) => j.state === 'running').length;
    for (const j of this.jobs) {
      if (running >= this.maxInFlight) break;
      if (j.state === 'waiting') { running++; this.run(j); }
    }
  }

  async run(job) {
    job.state = 'running';
    const arm = () => { clearTimeout(job.timer); job.timer = setTimeout(() => this.fail(new Error('Gemini stopped sending audio')), this.audioTimeout); };
    arm();
    try {
      // English style notes (a mood, and the pace that fixes Gemini's slow default) stay off Arabic: Google's own
      // guidance for non-English transcripts is English audio tags, and no page promises these notes for Arabic.
      const style = isArabic(job.text) ? null : [job.style, GEMINI_PACE].filter(Boolean).join(', ');
      const r = await this.fetchImpl(`${GEMINI_API}/interactions`, {
        method: 'POST', headers: { 'x-goog-api-key': this.key, 'content-type': 'application/json' },
        body: JSON.stringify(speechRequest(job.text, { voice: job.voice ?? this.voice, model: this.model, style })), signal: this.stopper.signal,
      });
      if (!r.ok) {
        const said = (await r.text().catch(() => '')).match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1];
        throw Object.assign(new Error(r.status === 429 ? 'Gemini is rate limiting' : `Gemini: ${said ?? `error ${r.status}`}`), { status: r.status });
      }
      const text = new TextDecoder();
      let rest = '', got = false;
      const line = (l) => {
        // Server-sent events: only the "data:" lines matter ("event:" repeats what's in them; "[DONE]" ends it).
        const s = l.replace(/^data:\s*/, '').trim();
        if (s[0] !== '{') return;
        let m;
        try { m = JSON.parse(s); } catch { return; }
        if (m.error) throw new Error(`Gemini: ${m.error.message ?? 'error'}`);
        if (m.delta?.type !== 'audio' || !m.delta.data) return;
        const pcm = this.whole(job, Buffer.from(m.delta.data, 'base64'));
        if (!pcm.length) return;
        got = true; arm();
        job.chunks.push(pcm);
        this.drain();
      };
      for await (const part of r.body) {
        if (this.state === 'done') return;
        const lines = (rest + text.decode(part, { stream: true })).split('\n');
        rest = lines.pop();
        for (const l of lines) line(l);
      }
      line(rest);
      if (!got) throw new Error('Gemini sent no audio');
    } catch (e) {
      return this.fail(e);
    }
    if (this.state === 'done') return;
    clearTimeout(job.timer);
    job.state = 'done';
    this.pump();
    this.drain();
  }

  // Hand on what's ready, in the order said; a sentence still streaming holds back the ones after it.
  drain() {
    while (this.state !== 'done' && this.head < this.jobs.length) {
      const j = this.jobs[this.head];
      for (const pcm of j.chunks.splice(0)) { this.heard = true; this.onAudio?.(pcm); }
      if (j.state !== 'done') return;
      this.head++;
    }
    if (this.state === 'ending') { this.close(); this.onEnd?.(); }
  }

  // PCM samples are 2 bytes; a chunk can end mid-sample, so carry the odd byte into the sentence's next one.
  whole(job, b) {
    if (job.odd != null) { b = Buffer.concat([Buffer.from([job.odd]), b]); job.odd = null; }
    if (b.length % 2) { job.odd = b[b.length - 1]; b = b.subarray(0, b.length - 1); }
    return b;
  }

  close() {
    if (this.state === 'done') return;
    this.state = 'done';
    for (const j of this.jobs) clearTimeout(j.timer);
    this.stopper.abort();
  }

  fail(err) {
    if (this.state === 'done') return;
    this.close();
    err.heard = this.heard;
    this.onError?.(err);
  }
}

/**
 * Gemini Live: one realtime socket per reply, each sentence sent as its own turn as it's ready and the audio handed on
 * the moment it arrives (no waiting for a whole sentence to be rendered). Same shape as GeminiVoice and FishVoice, so
 * the speaker can use any of them: open(), say(text), end(), abort(), onAudio/onEnd/onError.
 * Unlike the TTS models it is a conversation model, so the first message tells it to read the text and nothing else,
 * and the language is left to it (a reply in Arabic is read in Arabic, in the voice picked).
 */
export class GeminiLiveVoice {
  constructor({ key, voice = GEMINI_DEFAULT_VOICE, model = GEMINI_LIVE_MODEL, WebSocketImpl = globalThis.WebSocket, onAudio, onEnd, onError, openTimeout = 8000, audioTimeout = 10000 }) {
    Object.assign(this, { key, voice, model, WebSocketImpl, onAudio, onEnd, onError, openTimeout, audioTimeout });
    this.state = 'open'; // open → ending → done
    this.ready = false; // setupComplete has arrived: turns can go out
    this.queue = []; // sends waiting for the setup to be acknowledged
    this.said = 0; // turns sent (one per sentence)
    this.finished = 0; // turns the model has read back
    this.heard = false;
    this.odd = null; // a sample's other byte, when a frame ends mid-sample
    this.timer = null;
    this.refused = null; // { status } when the server sent an error before closing
    this.ws = null;
  }

  open() {
    try {
      this.ws = new this.WebSocketImpl(`${GEMINI_LIVE_API}?key=${encodeURIComponent(this.key)}`);
    } catch (e) {
      this.fail(e);
      return this;
    }
    const ws = this.ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { try { this.ws.send(JSON.stringify(liveSetup(this.voice, this.model))); } catch { /* socket gone */ } this.arm('Gemini Live did not open', this.openTimeout); };
    ws.onmessage = (e) => { this.message(e?.data).catch((err) => this.fail(err)); };
    ws.onerror = () => this.fail(new Error(this.heard ? 'Gemini Live connection dropped' : 'Could not reach Gemini Live'));
    // A socket that closes by itself (a limit, a refusal, the network) is a failure unless the reply had already ended.
    ws.onclose = (e) => {
      if (this.state === 'done') return;
      const why = String(e?.reason ?? '').trim().slice(0, 200);
      const err = new Error(why || (this.heard ? 'Gemini Live connection dropped' : 'Could not reach Gemini Live'));
      if (this.refused?.status) err.status = this.refused.status;
      this.fail(err);
    };
    return this;
  }

  say(text) {
    if (this.state !== 'open') return;
    const p = plain(text); // the Fish voice cues are ours: Live would read them out
    if (!/[\p{L}\p{N}]/u.test(p.text.replace(/<[^>]*>/g, ''))) return; // nothing to read ("…", a lone cue or tag)
    this.said++;
    this.send(liveTurn(p.text));
    this.arm('Gemini Live stopped sending audio');
  }

  end() {
    if (this.state !== 'open') return;
    this.state = 'ending';
    this.drain();
  }

  abort() { this.close(); }

  // Out now if the session is set up, else in order once setupComplete arrives.
  send(m) {
    if (this.state === 'done') return;
    const s = JSON.stringify(m);
    if (this.ready && this.ws?.readyState === 1) this.ws.send(s);
    else this.queue.push(s);
  }

  async message(data) {
    if (this.state === 'done') return;
    let text = typeof data === 'string' ? data : null;
    if (text == null && data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
    else if (text == null && typeof data?.text === 'function') text = await data.text();
    else if (text == null) text = Buffer.from(data ?? '').toString('utf8');
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.error) {
      const code = Number(m.error.code);
      this.refused = { status: code >= 400 && code < 600 ? code : null };
      throw Object.assign(new Error(`Gemini Live: ${m.error.message ?? 'error'}`), this.refused.status ? { status: this.refused.status } : {});
    }
    if (m.setupComplete) {
      this.ready = true;
      for (const s of this.queue.splice(0)) this.ws?.send(s);
      this.arm(this.said ? 'Gemini Live stopped sending audio' : 'Gemini Live did not open');
      this.drain();
      return;
    }
    const c = m.serverContent;
    if (!c) return;
    // A message can carry more than one part; each inline audio part is raw 16-bit PCM at 24 kHz.
    for (const part of c.modelTurn?.parts ?? []) {
      const d = part.inlineData?.data;
      if (!d) continue;
      const pcm = this.whole(Buffer.from(d, 'base64'));
      if (!pcm.length) continue;
      this.heard = true;
      this.arm('Gemini Live stopped sending audio');
      this.onAudio?.(pcm);
    }
    if (c.turnComplete) { this.finished++; this.drain(); }
  }

  // One sentence read back is a turn: with every sentence read, an ended reply is over. A reply that produced no audio
  // at all is a failure, not a silent success (the speaker retries it on another model).
  drain() {
    if (this.state !== 'ending' || this.finished < this.said) return;
    if (this.said && !this.heard) return this.fail(new Error('Gemini Live sent no audio'));
    this.close();
    this.onEnd?.();
  }

  // A sample is 2 bytes; a frame can end mid-sample, so carry the odd byte into the next one.
  whole(b) {
    if (this.odd != null) { b = Buffer.concat([Buffer.from([this.odd]), b]); this.odd = null; }
    if (b.length % 2) { this.odd = b[b.length - 1]; b = b.subarray(0, b.length - 1); }
    return b;
  }

  arm(why, ms = this.audioTimeout) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(new Error(why)), ms);
    this.timer.unref?.();
  }

  close() {
    if (this.state === 'done') return;
    this.state = 'done';
    clearTimeout(this.timer);
    try { this.ws?.close(); } catch { /* already closed */ }
  }

  fail(err) {
    if (this.state === 'done') return;
    this.close();
    err.heard = this.heard;
    this.onError?.(err);
  }
}

/** The Gemini voice for a reply: Live (a socket, a turn per sentence) or one of the exact-reading models. */
export class GeminiSpeaker {
  constructor(o = {}) {
    return isLiveModel(o.model ?? GEMINI_LIVE_MODEL) ? new GeminiLiveVoice(o) : new GeminiVoice(o);
  }
}
