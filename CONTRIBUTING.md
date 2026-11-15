# Contributing

Thanks for helping out. Bug reports, ideas and pull requests are all welcome.

This repository is in a **rebranding/implementation transition to JARVIS V2** (see `README.md` and `JARVIS_V2_SPEC.md`). Some names, paths, docs, and UI strings may still reference legacy Roamies/Little Boy identifiers while the migration is in progress.

## Setup

With Rust, Node.js 22+, the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and, on macOS,
the Xcode Command Line Tools installed:

```bash
git clone https://github.com/KenKaiii/Roamies.git
cd Roamies/showcase/tauri
(cd sidecar && npm ci && npm test)
./build.sh dev        # debug build
./build.sh            # release bundle for this OS
```

## Before you open a pull request

- Run `npm test` in `showcase/tauri/sidecar`.
- Run `shellcheck` on any shell script you changed.
- Keep CI (`.github/workflows/ci.yml`) green.
- Keep pull requests small and focused on one thing.

## The safety rule

Every tool that touches files, commands, URLs or other apps goes through
`showcase/tauri/sidecar/safety.mjs`. Add a test case in `showcase/tauri/sidecar/test/safety.test.mjs` with
every rule change.

## Security problems

Please don't open a public issue. Report them as described in [SECURITY.md](SECURITY.md).
