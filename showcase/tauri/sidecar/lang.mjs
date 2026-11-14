// What language a sentence being spoken is in, and which voice should say it.
// The voices are not language-neutral in practice, even where the service is: Fish Audio's own docs say a voice cloned
// from one language speaks another "with varying accuracy", and Gemini documents Arabic at the model level (Standard
// Arabic is in its language list) without promising it for every one of the 30 voices. So the language is worked out
// from the text, each provider can have a voice per language, and anything English-only (style notes, Fish's [warm]
// cues, our own mood prefixes) never goes on Arabic text.
//
// Scripts are counted per letter, not per word, so "OpenAI عربي" is still Arabic-dominant; digits and punctuation
// (ASCII or Arabic-Indic) don't count either way.

// Arabic (including the presentation forms) and the Latin letters used in English and the European names inside it.
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/gu;
const LATIN = /[A-Za-z\u00C0-\u024F]/g;
// Directional marks and isolates (ALM, LRM, RLM, embeddings, overrides, isolates, BOM): invisible controls a chat
// reply sometimes carries. Speech engines either read them or trip on them, so they're dropped before sending text.
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Arabic and Latin letter counts, ignoring voice cues, tags, digits and punctuation. */
export function scriptMix(text) {
  const s = String(text ?? '').replace(/\[[^\]]*\]/g, ' ').replace(/<[^>]*>/g, ' ');
  // The ranges hold digits (٠-٩) and punctuation (، ؛ ؟) too: only letters count, so "٢٠٢٦" isn't a language.
  const letters = (re) => (s.match(re) ?? []).filter((c) => /\p{L}/u.test(c)).length;
  return { arabic: letters(ARABIC), latin: letters(LATIN) };
}

/**
 * 'ar' (Arabic script), 'en' (Latin), 'mixed' (both, at least 20% each) or null (no letters: digits, punctuation,
 * emoji). Mixed matters: a style note or a wrong-language voice hurts it most.
 */
export function languageOf(text) {
  const { arabic, latin } = scriptMix(text);
  const all = arabic + latin;
  if (!all) return null;
  if (arabic && latin && Math.min(arabic, latin) / all >= 0.2) return 'mixed';
  return arabic > latin ? 'ar' : 'en';
}

/** Is this mostly Arabic? Mixed text follows whichever script has more letters. */
export const isArabic = (text) => {
  const { arabic, latin } = scriptMix(text);
  return arabic > 0 && arabic >= latin;
};

/**
 * The voice for a sentence: `voices.ar` or `voices.en` when one is set for that language, else `fallback` (the
 * provider's own default, such as the look's voice). Mixed text follows its dominant script. Pure digits and
 * punctuation use the fallback rather than switching voices for "1, 2, 3".
 * Returns { voice, lang, arabic }.
 */
export function pickVoice(text, { voices = {}, fallback = null } = {}) {
  const lang = languageOf(text);
  const arabic = isArabic(text);
  const voice = (arabic ? voices?.ar : voices?.en) ?? fallback;
  return { voice, lang, arabic };
}

/** Text with the invisible bidi controls removed (safe for English too: they're never part of the words). */
export const cleanSpoken = (text) => String(text ?? '').replace(BIDI, '');

/**
 * Can this voice say Arabic, as far as its own documentation goes? `arabic` is true, false or null (unknown: never
 * claimed either way). `evidence` says what the answer rests on, for the panel's note.
 * - Fish Audio: the S2 models list Arabic (and Arabic text normalization); the voice still decides how it sounds.
 * - Gemini: Standard Arabic is in the TTS language list and the language is detected from the text.
 * - VoiceStudio: whatever engine it's using. OmniVoice (its default) lists Standard Arabic; KittenTTS 0.8 and
 *   CosyVoice are English-only (CosyVoice 2/3 add Chinese, Japanese, Korean and a few European languages, no Arabic).
 */
export function arabicSupport(provider, engine = null) {
  if (provider === 'fish') {
    return { arabic: true, evidence: 'model', note: "Fish's S2 models list Arabic. How it sounds depends on the voice." };
  }
  if (provider === 'gemini') {
    return { arabic: true, evidence: 'model', note: 'Gemini speaks Standard Arabic and picks the language from the text.' };
  }
  if (provider === 'voicestudio') {
    const e = String(engine ?? '');
    if (/omni/i.test(e)) return { arabic: true, evidence: 'engine', note: 'OmniVoice lists Standard Arabic.' };
    if (/kitten|cosy/i.test(e)) {
      return { arabic: false, evidence: 'engine', note: `${e} doesn't list Arabic. Pick an OmniVoice engine in VoiceStudio for Arabic replies.` };
    }
    return { arabic: null, evidence: 'unknown', note: "This engine's languages aren't known here, so Arabic may come out wrong." };
  }
  return { arabic: null, evidence: 'unknown', note: 'Unknown voice service.' };
}
