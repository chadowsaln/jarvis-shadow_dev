# AGENTS.md

**JARVIS V2** (rebranding WIP from Roamies/Little Boy): a Tauri 2 desktop app (Rust shell in `showcase/tauri/src-tauri`, package/bin `jarvis_v2`), a Node sidecar that runs the agent (`showcase/tauri/sidecar`, package `jarvis-v2-sidekick`), shared browser/overlay JS in `showcase/roamies`, macOS Swift helpers built by `src-tauri/build.rs`, and two Windows helpers built by `build.sh` for Windows targets: voice (`src-tauri/voice-win`, Rust + Parakeet; `--transcribe <wav>` and `--test-audio <wav>` test speech without a Windows PC, see the top of its `main.rs`) and hands (`src-tauri/hands-win`, the twin of `hands/main.swift`: same commands and JSON, over Win32, UI Automation and Windows OCR). Only hands-win's `logic.rs` builds off Windows, so `cargo test` there runs its checks anywhere; from a Mac, `cargo xwin check --target x86_64-pc-windows-msvc` type-checks the Windows code with the real SDK.

Linux (beta) uses the same voice helper (`voice-win` builds for Linux too: ALSA mic, talk keys over X11, and a `toggle` command for `--talk` on Wayland) and no hands helper. Its shell code is `src-tauri/src/linux.rs`: every window is an X11 window (`GDK_BACKEND=x11` on Wayland, through XWayland), the overlay lets clicks through by region (the page reports its click areas, `host.js` → `set_hit_rects`) instead of following the cursor, and screenshots, copying, Open at Login and updater behavior follow platform config. Debug aids: `ROAMIES_TRACE=1` prints the overlay's click areas, and in debug builds `ROAMIES_TEST_AUDIO=<wav>` stands in for the microphone.

**Identity/config (current):** `showcase/tauri/src-tauri/tauri.conf.json` → `productName` `JARVIS V2`, `version` `0.1.0`, `identifier` `ai.jarvis.v2`. Many internal names/env vars/paths/data locations and UI strings still use legacy `Roamies`/`Little Boy`/`ROAMIES_*`/`roamies-*` identifiers until the rebrand is completed.

**Spec/roadmap:** see `JARVIS_V2_SPEC.md`. V2.1 (Linux Computer Control) has partial/WIP scaffolding (`sidecar/computer-control/`, `linux_*` tools in `sidecar/tools.mjs`) not fully verified end-to-end; V2.2–V2.6 not implemented. Keep implementation aligned with the spec.

## Commands

```sh
cd showcase/tauri/sidecar && npm ci     # install sidecar deps
npm test                                # sidecar tests (reply stream, storage, pointing, safety, voice model download)
npm run build                           # bundle the sidecar into dist/
cd .. && ./build.sh dev                 # web files + sidecar + debug `cargo build`
./build.sh                              # release bundle for this OS (signs on macOS if a Developer ID is in the keychain)
```

There is no linter configured yet.

**Packaging notes (current):** Linux `.deb`/`.rpm` bundles can be produced (JARVIS V2 0.1.0 naming with current config); AppImage packaging may fail in some environments (`linuxdeploy`/tooling). Bundled Node runtime was removed from Linux/Windows/macOS external bins to avoid `/usr/bin/node` conflicts; a system Node.js (>=22) is required for the sidecar. Creating updater artifacts requires `TAURI_SIGNING_PRIVATE_KEY`.

Releases: push a `v*` tag (or run `.github/workflows/release.yml` by hand). It builds a signed, notarized macOS DMG (Apple silicon and Intel), an unsigned Windows installer and Linux bundles (AppImage, .deb, .rpm) into a draft GitHub release per workflow/tooling availability. Keep `plugins.updater.pubkey` in `tauri.conf.json` matching the signing key.

## Rules

- Every tool that touches files, commands, URLs or other apps goes through `showcase/tauri/sidecar/safety.mjs`
  (tested in `test/safety.test.mjs`); the hands helpers also refuse to type or click in the apps in `HANDS_OFF`
  (by bundle id in `hands/main.swift`, by program name in `hands-win/src/logic.rs`).
  Add a test case with every rule change.
- In-app updates read `latest.json` from the newest published release, signed with the key in the
  `TAURI_SIGNING_PRIVATE_KEY` secret. Keep `plugins.updater.pubkey` in `tauri.conf.json` matching it.
  When GitHub's release links fail, the updater falls back to the copy on the `updates` branch, which
  `.github/workflows/update-feed.yml` writes whenever a release is published; downloads go through the API.

- CI lives in `.github/workflows/ci.yml` and must stay green.
- Never commit with `--no-verify`.
- Never commit experiments (prototypes, test pages, design tools). They stay local and are listed in `.git/info/exclude`; check `git status` before every commit.
- Never commit secrets (Apple ID passwords, certificates, `~/.gg/auth.json`); signing credentials go in GitHub Actions secrets.
