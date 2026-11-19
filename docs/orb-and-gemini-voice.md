# The orb, and hearing through Gemini

Implementation report for the visual-orb upgrade and the multilingual voice work. It records what was audited, what
was reused, what changed, how it was checked, and what is still open.

## 0. Audit (before any change)

### Rendering — already a real system, extended rather than replaced

| Piece | Role |
| --- | --- |
| `showcase/roamies/10-dither.js` | The LED-cell kit every look draws through (`body()`, `cursor()`, `over()`). Owns the frame loop and cell budget. |
| `showcase/roamies/hybrid.js` | The `hybrid` look: composites a WebGL render over the canvas, keeps the LED orb as the fallback when WebGL 2 is missing or lost. |
| `showcase/roamies/hybrid3d.js` | The renderer: WebGL 2, no libraries, one canvas per creature. |
| `showcase/roamies/orb-state.js` | Pure reducer from app events to one state name; `fromFrame()` reads what a frame already knows. |
| `showcase/roamies/theme.js` | Colors, glow, particle count, quality and animation switches; the renderer owns no colors. |
| `showcase/roamies/core.js` | The page frame loop; already computes `env.sleepy` (pointer still for >12 s) and naps when the entity is off screen. |
| `showcase/roamies/voice-out.js` | Plays PCM chunks back to back, meters the level, reports playback rate. |

Consequences honoured in this work: no second renderer, no second state machine, no colors baked into shaders, no
new frame loop. Sleeping is the app's existing `env.sleepy`, not a timer the renderer invented.

### Voice — TTS was already complete, hearing was local only

| Piece | Role |
| --- | --- |
| `sidekick/speaker.mjs` | Picks the speaking service (Fish Audio, Gemini, VoiceStudio), makes "beats", hands PCM to the overlay. |
| `sidekick/gemini.mjs` | Gemini TTS (streaming per sentence, voices, Arabic handling, pacing). |
| `sidekick/speech.mjs` | Decides what is said: prose only, no code/lists/Markdown, voice cues, sentence splitting. |
| `sidekick/lang.mjs` | Arabic/Latin script counting, language of a sentence, voice per language, bidi cleanup. |
| `src-tauri/voice/main.swift` | macOS: Apple Speech recognizer, on-device. |
| `src-tauri/voice-win` | Windows/Linux: Parakeet TDT 0.6B (English-only) on the PC; the recorder and session state machine. |
| `src-tauri/src/voice.rs`, `main.rs` | Start the helper, forward `final`/`partial`/`level` to the sidekick. |

So: TTS was done; **STT had no cloud provider, no language identification, and no Arabic on Windows/Linux.**
`lang.mjs` already solved language *output*; this work adds language *input*.

### Risks identified

- The Rust helper drains its audio buffer into the transcriber, so the audio had to be captured before that point.
- Anything sent through the sidecar's stdio is a JSON line; unbounded audio would be a memory hazard → trimmed and
  capped.
- macOS recognition is on-device and the Swift helper cannot be compiled in this environment; changing it would have
  been unverifiable. Hearing through Gemini is therefore offered where the Rust helper runs, and the Mac keeps its
  own recognizer (which already handles Arabic through the Mac's languages).

## 1. The orb

One coherent entity, built from the motifs shared by the six references: a hot core, woven crossing loops, an
engraved bezel with a tick scale, radial filament bursts, scattered mini-ellipses, inclined structural rings, a
drifting particle shell, and pulses that leave the middle.

| Reference motif | In the renderer |
| --- | --- |
| Hand-drawn woven curves | **Orbits**: five 3D Lissajous loops (`a:b` 3:2, 5:3, 4:3, 7:4, 2:3), each turned about its own axes at its own speed, brightness running along the wire, depth dimming the far side. |
| Engraved concentric arcs | **Bezel** (field shader): three segmented arcs at 1.05/1.15/1.26 R, alternate directions, plus a 120-mark tick scale at 1.36 R with a dark sector. |
| Radiating filaments | Up to 220 rays from 0.14–0.34 R out to 1.08–1.42 R, each with its own reach (`var`), dashes and tone, breathing with the voice. |
| Scattered small ellipses | 4–12 mini-orbits drifting on their own paths, each a real ellipse at its own inclination. |
| Hot centre with glow | **Core**: ray-sphere with value-noise plasma, a sharp nucleus (`exp(-26 d²)`), thin energy veins, sliding latitude shells, Fresnel rim. |
| Structural rings | Five bead-chain rings at distinct inclinations, radii 0.96–1.32, with machined breaks and two luminous nodes running each. |
| Particle field | Drifting shell points with neighbour links, as before. |
| Occasional emissions | **Pulses**: rings leaving the core, rhythmic with the voice while speaking. |

Also added: an inner wire **icosahedron** and a counter-rotating **octahedron** (the "inner geometric structures"),
and a real outer energy field — which exposed a genuine bug: the field was being drawn through the sphere's 69 %-wide
quad, clipping the bezel and every pulse.

### States (driven by real app events)

`idle · listening · thinking · tool_execution · speaking · success · error · offline · sleeping`

- `sleeping` is new in `orb-state.js` (rank above `idle`, so a dozing entity is not washed out by an idle frame) and
  comes from `core.js`'s existing pointer-stillness signal, emitted as `sleep`/`wake` events. Nothing work-related can
  doze.
- Each state changes *pace*, not just brightness: `PACE` scales the renderer's own accumulated clock
  (thinking ≈ ×1.9, sleeping ×0.16), so rings, orbits and geometry speed up or crawl together without jumping.
- Listening pulls the energy waves inward and uses the **microphone** level (the pose's `heard`), speaking uses the
  **voice** level; thinking brightens and speeds the geometry; tool execution raises orbital activity; error is a
  controlled flicker of the bezel and body in the theme's own colors; offline dims; sleeping is barely alight.
- Success blooms briefly.

### Six styles

The reference sheet is six different orbs, not one. Rather than six renderers, the renderer is one shader pair plus a
table (`LOOKS` in `hybrid3d.js`) saying how much of each motif a style shows; `theme.current.style` picks the table
row. Switching is a settings change and shows on the next frame.

| Style | What it leans on | Palette it brings |
| --- | --- | --- |
| **Hybrid** (default) | Everything at once: orbits, bezel, rings, filaments, particles, inner solids. | keeps the colors you have |
| **Engraved Ring** | The outer instrument: a heavy cast bezel with a sector cut out of it, a dense tick scale, and dendrites reaching into the rim; the core is a tight pin, the middle left open. | ember orange |
| **Woven** | Only the drawn loops: five thick overlapping Lissajous wires reaching the frame corners, the drifting ellipses, no bezel, a dark middle. | pale teal |
| **Torus** | Three large near-circular loops, four passes thick, with two bead rings and a hot core you can see through them. | amber |
| **Burst** | A detonation: 220 rays in three dotted dashes from a sharp point of a core out past the bezel, two thin ellipses through it. | cyan |
| **Spokes** | Wedges of parallel spines in five fan clusters, an open middle strung with bead chains, ember ellipses scattered through the fan ends. | steel blue with ember beads |
| **Arcs** | A broken cast rim over long dendrites that reach the middle, dotted rings inside, faint tracks. | ice cyan |

### Tuned against the references, at the widget's own size

Each style was compared with its reference sheet, side by side, at 348 CSS px (the widget's size) on 1× and 1.5×
backing stores and in the cursor form (`showcase/_orb-compare.html`, local only). The levers the tuning needed, all of
them per style and none of them new code paths in the shaders:

| Lever | What it fixed |
| --- | --- |
| Ray count 96 → 220, and per-ray reach (`fil.var`) | The references' bursts, fans and dendrites are *dense* and *uneven*; 96 even rays read as a spoked wheel. |
| A dotted dash pattern (`fil.dashes` + `gap`) | A burst's streaks are trails, not lines. |
| Fan width (`fil.spread` at full width for `cluster > 0`) | The spokes were five coincident needles instead of five wedges of spines. |
| Filament tone (`fil.tone`) | Spines could only be the neural tone; a burst is now the reactor's, spokes the reactor's blue, a hatch the ember. |
| Extra filament passes (`fil.passes`) | 1 px GL lines vanish at 348 px; two or three passes read as the reference's ink weight. |
| A sector cut out of the bezel (`field.break`) | Both the engraved ring and the arcs references are *broken* rims, not complete circles. |
| Core tightness (`orb.n`) vs core gain | A soft `exp(-26 d²)` nucleus was a white ball; burst and arcs want a sharp point, ring wants a dim instrument. |
| Loop count and weight (`orbits`, `thick`) | Torus went from five thin ellipses (an atom) to three heavy ones; woven from tidy rings to loops filling the frame. |

What still differs from the references, style by style — this is the honest remainder, not a uniform "close enough":

- **Engraved Ring** — the reference's middle is a *branching* dendrite tree with a solid instrument at the centre; ours
  has straight radial hatch and an open middle with a pin. The bezel now has its gap and hatching, but the ref's rim
  is cast and irregular in width; ours is geometrically even.
- **Woven** — ours is Lissajous loops: smooth, continuous, closed. The reference's scribbles kink, double back and
  have drawn ends. Five curves cannot be a scribble; the loop vocabulary is the ceiling here.
- **Torus** — closest of the six. The reference's loops are gold with a travelling highlight and a soft haze; ours has
  the highlight but no haze (bloom is a cheap re-draw, not a blur), and its core is a point where the reference's is
  a small glowing sphere.
- **Burst** — the reference's streaks are long and bright to the frame edge with clean gaps; ours are dimmer at 1×, and
  its two ellipses are more prominent than the ref's.
- **Spokes** — our fans are narrower and fewer-marked than the ref's (which are stacked with rows of white dots); the
  bead loops sit inside the fans instead of at their ends.
- **Arcs** — ours has the broken cast rim and the dendrites, but the reference's filaments *fork* and thicken toward
  the middle; ours are straight rays from a dark centre.

**The cursor form carries the structure too.** Each style now has its own pointer glyph in the LED cell language — a
segmented bezel (Engraved Ring), crossing loops (Woven), two enclosing rings with a sweep (Torus), radial dashes
(Burst), fan spines with a bead (Spokes), broken tracks (Arcs), and the old reticle for Hybrid — with the hotspot tick
unchanged. The glyph is chosen by the same `styleFor()` the renderer uses, so pinning a style or following the state
changes the pointer as well; the six are checked to be distinct and to stay inside the pointer slot
(`test/hybrid.test.mjs`).

Picking a style applies its palette (per the requested behaviour) and every color stays editable afterwards; Hybrid
never repaints an existing theme. Choices live in the panel's Appearance → Hybrid entity → **Style**, are saved with
the rest of the theme (`theme.style`), survive export/import and a restart, and an unknown style falls back to Hybrid
with a note instead of blanking the orb.

### Following the state

By default (`theme.styleMode: 'auto'`) the orb does not keep one structure: `theme.js` maps each agent state to a
style (`STATE_STYLE`) and `hybrid3d.js` asks for it every frame, so the entity changes shape while it works.

| State | Structure | Why |
| --- | --- | --- |
| idle | Arcs | broken tracks: alert, not busy |
| listening | Woven | overlapping loops, the most open and receptive |
| thinking | Burst | rays out of a tight core: effort radiating |
| tool_execution | Spokes | spines and beads: a machine doing something |
| speaking | Torus | heavy rings: something is flowing out |
| success | Engraved Ring | the instrument blooms, once |
| error | Spokes | jagged spines, plus the existing flicker |
| offline | Arcs | the same calm tracks, dimmed by its own gains |
| sleeping | Woven | barely lit, at a crawl |

- **It morphs, it does not cut.** `mixLook()` eases every numeric field of the current structure toward the target
  with a ~0.2 s time constant (`1 - exp(-secs / 0.2)`), which is frame-rate independent and survives being
  interrupted by the next state. The tables themselves are read-only — they are constants of the renderer.
- **Colors do not change with the state.** A style's palette is applied only when a style is picked by hand; while
  following, the theme's colors stay put, so the orb never strobes between palettes.
- **The option to keep one style** is the same control: Appearance → **Follow my state** off, or simply pick a style
  chip (which turns the mode off and keeps that structure). The panel shows the whole state → style table under the
  chips while following is on.
- Settings are saved as part of the theme (`styleMode`), so the choice survives a restart and Export/Import; an
  unknown mode falls back to `auto` with a note.
- The LED fallback (no WebGL 2, animation off, lost context) keeps its single look: it is the safety net, and
  switching six LED structures there would cost more than it tells the user.

> **Bug this exposed:** the `line()` and `dots()` helpers bound their buffers and drew, but never uploaded the
> arrays that had just been filled (`gl.bufferData`). So the orbits, the satellites, the radial filaments, the tick
> scale, the inner wire solids, the bead chains, the nodes and the particle shell had never actually drawn — the
> visible picture came from the two shaders (core and bezel) alone. It went unnoticed because the shader layers look
> full, and because the readback checks only confirmed that *something* was lit. Woven made it obvious: with its core
> and bezel gains at nearly zero it showed only the sphere's rim. Both helpers now upload their own slice every
> frame, and the styles are what they should be as a result.
>
> Also fixed on the way: `hybrid3d.create()` assumed a `document` existed, so loading the module in the Node tests
> (where `hybrid.js` should simply fall back to the LED orb) threw instead of failing gracefully. It now reports
> `failed: 'no document'` and the fallback path is tested.

### Performance and safety

- All geometry lives in preallocated `Float32Array`s written in place; no allocation in the frame.
- Detail follows the backing canvas size (`≥420 px`, `≥260 px`, else): full motif set on the desktop-size orb,
  reduced counts on the small in-page orbs, so nothing turns into a smear.
- Auto-quality steps down when frames run long; a lost WebGL context is rebuilt once, then the LED fallback takes
  over for good; animation off leaves the last frame.
- Measured on this machine, CPU time to build and submit a frame (GL work is asynchronous and not included), at
  348 CSS px on a 1.5× backing store (522 px), quality pinned high: **hybrid 0.77, weave 0.65, torus 0.47, arcs 0.42,
  burst 0.40, spokes 0.32, ring 0.20 ms**. The denser tuning did not move this materially; the frame budget is
  16.7 ms and the mobile/iGPU case is the auto-quality step-down.

## 2. Hearing through Gemini

New `sidekick/stt.mjs`, one provider behind the existing voice pipeline:

- `gemini-3.5-transcribe` via the Interactions API with **automatic language identification** (an empty
  `language_codes` list, so code-switching is not fought by a hint).
- WAV encoding (16-bit mono, 16 kHz), silent ends trimmed (helper and module both do it), 90 s cap.
- Structured result: `{ ok, text, language, languages, ms, bytes, seconds }`, with `language` preferring the model's
  own tag and falling back to `lang.mjs`'s script counting (`ar` / `en` / `mixed`).
- Errors as reasons, never exceptions: `key`, `rate`, `network`, `empty`, `too_long`, `cancelled`. Nothing is sent
  without a key; a take with no audio never leaves the machine.
- Logs carry sizes, duration, language and character counts — never the key, never the samples (asserted in tests).

### Live smoke test

`test/hear-smoke.mjs` sends two real takes through the same call the sidecar makes and prints what came back:

```sh
cd showcase/tauri/sidecar
GEMINI_API_KEY=... npm run test:hear -- hello-ar.wav hello-en.wav   # or --ar … --en …
npm run test:hear -- --mock                                        # no key, no network (what CI runs)
```

- It checks the key first (`sttAccount`), so a bad key is `key: refused (key)` and **no audio is sent** — the one
  thing a refusal can't be about is the recording.
- Each take is described before it's sent: seconds, and anything that isn't 16 kHz mono 16-bit PCM (a mismatch is
  reported, not silently accepted — the point is to send what the helper produces). The chunks are walked rather than
  read at fixed offsets, so a recording out of Audacity or QuickTime (which puts a `LIST` chunk before the audio) is
  measured and trimmed on its sound, not on its metadata. Silence at both ends is trimmed the way the sidecar trims
  it, so the test isn't measuring the trimmer.
- It prints the transcript, the language the model named, the language the letters read as, and whether that was the
  language the take was spoken in. Code-switching (`mixed`) passes; the wrong language fails, and the exit code is
  0 / 1 / 2 (all heard / one wrong / usage or key).
- Nothing prints the key, the samples or a byte count of speech — only durations, words and languages.
- `--mock` is the offline mode: two generated WAVs and a canned answer in the API's own envelope, through the real
  request builder and reader. `test/hearsmoke.test.mjs` pins it (endpoint, header, WAV description, verdict, a wrong
  language failing the run, a refused key stopping before any take, an unreadable file reported), so the script
  itself can't rot between live runs.

### Flow

1. The helper records the take (Parakeet or Apple Speech may still read it on-device).
2. When the sidekick says hearing is Gemini (`voice_config.audio`), the shell starts/passes `--take-audio`; the
   helper keeps the trimmed WAV and attaches it to its `final` message.
3. `voice-win` → `voice.rs` → sidecar `hearInCloud()`: one transcription at a time, aborted when a new take starts.
4. On success its transcript enters the **existing** `onSpoken()` pipeline unchanged (agent, tools, permissions,
   orb events all identical). On failure the on-device words are used and the reason is said once per 10 minutes.
5. With Gemini hearing on, the 650 MB Parakeet model is **not required**: the helper records without an engine and
   sends audio only. Turning Gemini off brings the model prompt back.

### Security

- Keys stay where they already lived: `secrets` (Keychain / DPAPI / keyring). Hearing can have its own Gemini key
  (`gemini-stt`), otherwise it uses the AI's Gemini key, exactly like the Gemini voice.
- Requests are made in the sidecar only; the frontend never sees a key or an audio buffer.
- The panel states plainly that each take's audio goes to Google, and that a failure falls back to the on-device
  words. The setting is off by default.

## 3. Speaking speed

`speaker.setRate()` (0.75–1.3) scales the playback rate the PCM is handed to the overlay with, so it applies to the
next piece and to cached beats. Slower / Normal / Faster sits beside the voice-provider picker, with its trade-off
stated (tempo and pitch move together, like a tape — the honest limit of doing it on the way to the speakers).

## 4. Verification

Run and passing:

- `cd showcase/tauri/sidecar && npm test` — the whole suite, including the new `test/stt.test.mjs`
  (WAV header/samples/clipping, trimming, request shape and headers, five response shapes, language tag mapping,
  Arabic/English/mixed, every failure reason, "no key sends nothing", "silent take sends nothing", log hygiene).
- `cd showcase/tauri/src-tauri/voice-win && cargo test` — **22 passed**, including base64/WAV encoding, trimming,
  "audio is handed over only when asked", and "a handed-over take runs without the speech model".
- `cd showcase/tauri/src-tauri && cargo check` — compiles; only the warnings that were already there.
- `cd showcase/tauri/sidecar && npm run build` — the bundle contains the new module and both flags.
- `node --check` on every changed JS file.
- Orb: nine states rendered through WebGL 2 in a browser harness and read back with `gl.readPixels`
  (`showcase/_orb-lab.html`, local only). All nine produce distinct output; speaking is the brightest, sleeping the
  dimmest; no GL or document errors; frame cost measured as above.
- Styles: all seven rendered at 1240² and measured from the readback — every pair differs (mean luma difference
  0.07–0.28 on a 0–1 scale), each has the signature it should (Engraved Ring lights the bezel band and almost nothing
  inside, Burst lights the innermost ray band, Woven spreads loops across every band, Spokes/Arcs light the outer
  rings), and each brings its palette.
- Styles, against their references: `showcase/_orb-compare.html` renders each reference sheet next to the live
  renderer at 348 px on 1× and 1.5× backing stores and in the cursor form, with the lit fraction and mean colour of
  each (`local only`). Quality is pinned high there, because auto quality steps down in a headless browser and halves
  the detail — which is how the first tuning pass came out too sparse. The remaining differences are listed under
  **Tuned against the references** above.
- Cursor forms: all six glyphs rendered at 8× (visible cells) and checked through the DOM for distinctness; the
  tests then pin what the strip showed — six different glyphs, each inside the pointer slot, chosen by `styleFor()`
  (pinned style and `auto` state), with the hotspot tick in every one.
- Morph leakage: `mixLook` only walks the keys of the style it eases *toward*, so a style that left a field out kept
  the previous style's value (a burst's three passes and its tone would follow it into the weave). Every style now
  names every field, `mixLook` assigns instead of interpolating at k = 1 (so it lands exactly), and a test asserts
  all seven tables have the same key set.
- `test/hybrid.test.mjs` now loads the 3D module too and pins the contract between the two lists: every style the
  settings offer has a look table, every gain is a number, the counts fit their buffers, no two tables are equal,
  an unknown style falls back to the merged orb — and, with no `document`, the renderer fails politely and the LED
  fallback still draws.
- Panel: Appearance renders the Style group with all seven picks; choosing Torus applied `style: 'torus'` and its
  amber palette through `Roamie.theme` (saving is the panel's existing `theme:` message, covered by the theme tests).
- `test/theme.test.mjs` gained the styles: ids and order, each palette applied, "editing a color keeps the structure",
  "Hybrid does not repaint", unknown style refused, and the style surviving serialize/parse. It also covers the map:
  all nine states, every value a real style, the same state giving the same structure in `auto`, the picked style in
  `fixed`, an unmapped state falling back to the picked style, an error never drawing the success structure, the
  mode validated and saved.
- `test/hybrid.test.mjs` covers the renderer half of the map: each state's style exists in `LOOKS`, `mixLook` eases
  between two tables without writing to either, ends exactly on the target, and an unknown style falls back.
- Following the state, in the harness: driving all nine states reported `arcs, weave, burst, spokes, torus, ring,
  spokes, arcs, weave` from `api.stats.style`; `fixed` reported `torus` for the same states; screenshots of `thinking`
  (burst) and `speaking` (torus) show the structures themselves.
- Panel: the toggle and the state map render, turning following off hides the map and keeps the picked style, picking
  a chip turns following off and applies that style's palette — all verified from the DOM after the click, with the
  map wrapping on three lines without clipping.
- Panel: the Voice page rendered with sample data; the Hearing group, provider picks, key row, model row and the
  cloud-audio note all render, and the selected provider is reflected.

Not verified, and why:

- **No live Gemini call** (no API key here). Every request/response path is covered against a fake transport, and
  `npm run test:hear` now exists for the real one (see §2), but it has only been run as far as its key check: with a
  deliberately bad key it reaches Google and reports `key: refused (key)` without sending a take.
- **No microphone capture** in this environment: the Rust take path is covered by its own tests with a WAV standing
  in for the mic, including the new no-model path, but no human speech was recorded.
- **macOS helper untouched**: Apple Speech keeps hearing; Gemini hearing is not offered there.
- **No compositor**: screenshots of the orb were impossible, so visual judgement rests on GPU readback and
  ASCII projections; the human eye should confirm the final look.

## 5. Open items

- The six styles are now tuned at the widget's own size (348 px, 1× and 1.5×) and the cursor forms exist, but both
  were judged from a browser harness, not from the live desktop widget. The step the harness can't take is watching
  them *morph* while the agent works: the 0.2 s cross-fade is verified numerically, not by eye over a real session.

- Run `npm run test:hear` with a real key and two short recordings (Arabic, English) — the script is ready, the
  first real answer from Google is not recorded yet.
- Optional: a macOS audio path to Gemini (the Swift helper would have to hand its buffer over, as the Rust one does).
- Optional: stream partial transcripts from Gemini instead of one pass at the end of a take.
- A mixed take in the smoke test (Arabic and English in one sentence) — `mixed` is accepted by the verdict, but no
  fixture exercises it yet.
