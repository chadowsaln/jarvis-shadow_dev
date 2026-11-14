# Audio in: which microphone listens, and which language it hears

What the input path really does on Linux and Windows, what was wrong with it, and what the Arabic support of each
voice service rests on. Measured on Fedora 44 / GNOME / Wayland / PipeWire 1.6.11 (Nov 2026).

## The input path (Linux)

`roamies-voice` is the helper that records: a small Rust binary, `--devices` lists microphones, `--record` records a
few seconds, both without the speech model or a window.

Three different lists exist for the same microphones, and they are not interchangeable:

| List | What it is | Bluetooth headset | Built-in mic |
|---|---|---|---|
| `pactl list sources` (PipeWire/PulseAudio) | what the desktop's sound settings show | `bluez_input.<mac>` | `alsa_input.pci-…` |
| `cpal` (`Device::description`) | raw ALSA PCMs | **not listed at all** | `HDA Intel PCH, ALC255 Analog` (×4) |
| `arecord -l` | ALSA hardware | not listed | card 0, device 0 |

So the old `open_mic()` — `cpal::default_host().default_input_device()` — had two problems on Linux:

1. **No choice.** There was no way to pick a microphone: whatever PipeWire called the default won, even when the
   user's headset was connected in A2DP (playback only, no capture) and the built-in mic was the sensible source.
2. **The ALSA list is misleading.** Opening the ALSA `HDA Intel PCH, ALC255 Analog` PCM on this machine returns a
   constant DC signal (≈ full scale, `mean +21847`) while PipeWire's own node for the same microphone is quiet; the
   numbers are different devices from the app's point of view, and only one of them is the user's microphone.

### What the app does now

- **Linux:** the picker lists PipeWire's *sources* (their node name and description), and a chosen source is recorded
  with `pw-record --target <node> --rate 16000 --channels 1 --format s16 --container raw -`. The default stays on
  cpal (which follows PipeWire's default) and cpal is still the fallback when `pactl`/`pw-record` aren't installed.
  `--container raw` matters: without it `pw-record` writes a container header and the bytes stop being 16-bit samples.
- **Windows:** unchanged — cpal/WASAPI, with the microphones the system lists.
- **A pick that isn't there** (unplugged, Bluetooth out of range, its HFP profile off) falls back to the default and
  says so (`{"type":"mic","state":"fallback"}`); the panel shows the fallback and listening keeps working.
- **A device that disappears mid-take** ends the take with `reason: "lost"` (existing behaviour, now also true for the
  PipeWire path: `pw-record` exiting closes the stream).
- The setting is `config.mic` (`""` = system default) and is handed to the running helper as `{"cmd":"mic","name":…}`,
  so switching takes effect without a restart.

`--record` reports what a real take would hear, which is what "it didn't hear me" needs:

```
$ roamies-voice --record 1.5 --out /tmp/mic.wav --mic "Pro 10s"
{"type":"record","file":"/tmp/mic.wav","samples":24064,"seconds":1.5,
 "peak_db":-14.1,"rms_db":-33.2,"mean_db":-38.0,"clipped":0,
 "verdict":"ok","device":{"used":"bluez_input.…","wanted":"bluez_input.…","fallback":false}}
```

`verdict` is `ok`, `silent` (peak below -40 dBFS: muted or a very quiet room) or `stuck` (a constant signal or
constant clipping — a muted internal mic whose driver hands back DC). Nothing about it changes PipeWire, ALSA or the
system default; it only reads.

`npm run test:audio` runs the same thing for the default and for a picked microphone, and skips cleanly when there is
no helper or no microphone.

## Arabic

The engines were checked against their own documentation, not assumed from "it has TTS".

| Service | Arabic | On what evidence | What the app does |
|---|---|---|---|
| Gemini TTS | yes | Standard Arabic is in the model's language list; the language is detected from the text | no English style note on Arabic sentences (no `speaking quickly`, no mood), the user's Arabic voice if one is picked |
| Fish Audio (S2 models) | yes | the S2 models list Arabic (and Arabic text normalization) | `language: "ar"` on the socket's start event for an Arabic reply (numbers and dates), the user's Arabic voice if picked; how it *sounds* still depends on the voice — Fish's own docs say accuracy varies per voice |
| VoiceStudio — OmniVoice (default) | yes | k2-fsa's language table lists Standard Arabic | speaks it |
| VoiceStudio — KittenTTS 0.8, CosyVoice | no | English only (CosyVoice 2/3 add Chinese/Japanese/Korean and some European languages) | the reply is reported as text (`onProblem`) instead of sending Arabic to an engine that would garble it; the panel says which engine to pick instead |

Voice selection is per language: `config.voiceLangs = { gemini: { ar: "Sulafat" }, voicestudio: { ar: "<profile id>" } }`.
A sentence is read in the voice picked for its language, else the service's own (the look's voice, the engine's
default). Detection is always automatic — `lang.mjs` counts letters per script, so `OpenAI عربي` is mixed and Arabic
digits (`٢٠٢٦`), punctuation (`، ؟`) and emoji decide nothing. Mixed text gets no fixed language tag (Fish detects each
chunk itself) and never an English style note.

Spoken text keeps Arabic as written: `؟` and `۔` end sentences (so speech starts on the first sentence), the invisible
bidi controls a chat reply can carry are removed, and no English mood cue (`[warm]`, `[excited]`) is put in front of
Arabic.

### Tests

- `npm test` — `test/lang.test.mjs` (detection, voice per language, engine support table, Arabic punctuation and bidi
  stripping) and `test/voicearabic.test.mjs` (Gemini request shape, Fish start event, VoiceStudio gating, cancellation
  and one-reply-at-a-time), plus the existing suites.
- `cargo test` in `src-tauri/voice-win` — the pick logic, the microphone verdict and the pick command.
- `npm run test:audio` — the real microphone path (see above); the only check that needs hardware.
