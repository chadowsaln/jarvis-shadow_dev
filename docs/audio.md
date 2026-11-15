# Audio in: microphone selection and language handling (JARVIS V2)

> Note: This document reflects the current implementation details during the Roamies/Little Boy → JARVIS V2 transition. Binary names, env vars, and some strings may still use legacy `roamies-*` / `ROAMIES_*` identifiers.

What the input path does on Linux and Windows, and what Arabic/language support depends on in each voice path.

## Input path (Linux)

The voice helper records audio: a Rust binary (currently `roamies-voice`), with modes such as `--devices` (list microphones) and `--record` (record without full app flow), as implemented in `showcase/tauri/src-tauri/voice-win/`.

On Linux, microphone sources can appear differently across PipeWire/PulseAudio, ALSA/cpal, and hardware listings; device choice and fallback behavior are important (especially with Bluetooth/A2DP vs HFP profiles and unplugged devices).

### Current behavior (implementation-dependent)

- **Linux:** microphone selection may use PipeWire sources when available (and fall back to other backends when not), to better match desktop audio routing.
- **Windows:** cpal/WASAPI path as implemented.
- **Unavailable selected device:** may fall back to default and report fallback state.
- **Device loss mid-capture:** may end the take with a loss/failure reason.
- Configuration and runtime control depend on current sidecar/shell integration (legacy config/env naming may still apply).

`--record` (where supported) is useful to verify what the helper actually captures (levels/verdict/device used). `npm run test:audio` in `showcase/tauri/sidecar` exercises audio-device checks when prerequisites are available.

## Language/Arabic handling

Language support depends on the selected TTS/STT engine and model/voice:

| Path | Arabic | Notes |
|---|---|---|
| Gemini TTS | supported (model-dependent) | language handling follows text/model behavior |
| Fish Audio (S2 models) | supported (model/voice-dependent) | quality varies by voice/model |
| VoiceStudio engines | depends on engine | some engines support Arabic, others are English-only; app should gate/report unsupported cases |

Detection and per-language voice selection behavior are implemented in sidecar code (e.g. language handling/tests) and may evolve during V2 development.

### Tests/checks

- Sidecar: `npm test` (includes language/voice-related tests where present).
- Voice helper (Rust): `cargo test` in `showcase/tauri/src-tauri/voice-win` (where applicable).
- Real-device audio: `npm run test:audio` (requires hardware/helper availability).
