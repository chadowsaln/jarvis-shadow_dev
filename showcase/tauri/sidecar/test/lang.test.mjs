import assert from 'node:assert/strict';
import { arabicSupport, cleanSpoken, isArabic, languageOf, pickVoice, scriptMix } from '../lang.mjs';
import { SpeechText, endsWithQuestion, speakable } from '../speech.mjs';

// Which language a sentence is in: Arabic letters, Latin letters, both (mixed), or nothing to go on.
assert.equal(languageOf('مرحبا، كيف حالك؟'), 'ar');
assert.equal(languageOf('Hello there.'), 'en');
assert.equal(languageOf('OpenAI عربي'), 'mixed', 'a name in Latin inside an Arabic sentence');
assert.equal(languageOf('مرحبا OpenAI'), 'mixed');
assert.equal(languageOf('2026 ٤٥٦ !!!'), null, 'digits and punctuation say nothing about the language');
assert.equal(languageOf('🙂'), null);
assert.equal(languageOf(''), null);
assert.equal(languageOf(null), null);
// Voice cues and tags aren't words: they never shift the language.
assert.deepEqual(scriptMix('[warm] مرحبا'), { arabic: 5, latin: 0 });
assert.deepEqual(scriptMix('<laugh> Ha'), { arabic: 0, latin: 2 });
assert.equal(isArabic('مرحبا'), true);
assert.equal(isArabic('Hello world'), false);
assert.equal(isArabic('Hello عربي'), false, 'the Latin side is longer');
assert.equal(isArabic('Hi يا'), true);

// A sentence in Arabic uses the Arabic voice when one is picked; otherwise the service's own voice.
assert.deepEqual(pickVoice('مرحبا بك.', { voices: { ar: 'ar-voice', en: 'en-voice' }, fallback: 'look-voice' }),
  { voice: 'ar-voice', lang: 'ar', arabic: true });
assert.deepEqual(pickVoice('Hello.', { voices: { ar: 'ar-voice', en: 'en-voice' }, fallback: 'look-voice' }),
  { voice: 'en-voice', lang: 'en', arabic: false });
assert.equal(pickVoice('مرحبا.', { voices: {}, fallback: 'look-voice' }).voice, 'look-voice', 'no Arabic voice picked yet');
assert.equal(pickVoice('1, 2, 3.', { voices: { ar: 'ar-voice' }, fallback: 'look-voice' }).voice, 'look-voice', 'numbers do not switch voices');
assert.equal(pickVoice('١٢٣.', { voices: { ar: 'ar-voice' }, fallback: 'look-voice' }).voice, 'look-voice', 'Arabic-Indic digits either');

// Invisible bidi controls are dropped (engines trip on them); real letters and joiners are kept.
assert.equal(cleanSpoken('\u200Fمرحبا\u200E بالعالم'), 'مرحبا بالعالم');
assert.equal(cleanSpoken('\u202BHello\u202C there'), 'Hello there');
assert.equal(cleanSpoken('می\u200Cخواهم'), 'می\u200Cخواهم', 'a zero-width non-joiner inside a word is part of it');

// What each service's own documentation says about Arabic (never assumed from "it has TTS").
assert.equal(arabicSupport('fish').arabic, true, 'the S2 models list Arabic');
assert.equal(arabicSupport('gemini').arabic, true, 'Standard Arabic is in the TTS language list');
assert.equal(arabicSupport('voicestudio', 'OmniVoice').arabic, true);
assert.equal(arabicSupport('voicestudio', 'k2-fsa/OmniVoice, multilingual').arabic, true);
assert.equal(arabicSupport('voicestudio', 'KittenTTS').arabic, false);
assert.equal(arabicSupport('voicestudio', 'CosyVoice 3').arabic, false);
assert.equal(arabicSupport('voicestudio', 'SomeOtherEngine').arabic, null, 'unknown is never claimed');
assert.equal(arabicSupport('voicestudio', null).arabic, null, 'no engine named: unknown');
assert.match(arabicSupport('voicestudio', 'KittenTTS').note, /OmniVoice/, 'it says what to do instead');
assert.equal(arabicSupport('nope').arabic, null);

// Arabic punctuation ends a sentence, so speech starts on the first sentence rather than waiting for a full stop.
const said = [];
const t = new SpeechText((s) => said.push(s));
t.push('مرحبا بك. ');
t.push('كيف حالك؟');
t.flush();
assert.deepEqual(said, ['مرحبا بك.', 'كيف حالك؟']);
assert.equal(endsWithQuestion('كيف حالك؟'), true);
assert.equal(endsWithQuestion('تمام.'), false);
const one = [];
const u = new SpeechText((s) => one.push(s));
u.push('جملة أولى۔ ');
u.push('جملة ثانية۔');
u.flush();
assert.deepEqual(one, ['جملة أولى۔', 'جملة ثانية۔'], 'the Arabic full stop ends a sentence too');

// English mood cues never go in front of Arabic (they'd be read out or ignored); English keeps them.
const arabic = [];
const a = new SpeechText((s) => arabic.push(s));
a.emote('wave');
a.push('مرحبا، أنا هنا.\n');
a.flush();
assert.deepEqual(arabic, ['مرحبا، أنا هنا.']);
const english = [];
const e = new SpeechText((s) => english.push(s));
e.emote('wave');
e.push('Hi, I am here.\n');
e.flush();
assert.deepEqual(english, ['[warm] Hi, I am here.']);

// Arabic survives what's removed from spoken text; a bidi mark doesn't.
assert.equal(speakable('\u200Fمرحبا **[بالعالم](https://example.com)** 🙂'), 'مرحبا بالعالم');
assert.equal(speakable('مرحبا…'), 'مرحبا…');
console.log('language tests: passed');
