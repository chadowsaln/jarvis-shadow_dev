# Third-party notices

JARVIS V2 (rebranding in progress from Roamies/Little Boy) is licensed under [AGPL-3.0](LICENSE). It builds on third-party components, each under its own license. Versions below reflect what is referenced in this repository/config at time of writing and may differ by build.

| Component | How it's used | License |
| --------- | ------------- | ------- |
| [Tauri](https://tauri.app) 2 (`tauri`, `tauri-build`) and plugins | desktop shell (`showcase/tauri/src-tauri/Cargo.toml`) | MIT OR Apache-2.0 |
| [Node.js](https://nodejs.org) | sidecar runtime; some packaging flows may fetch/bundle Node in dev/build scripts, but current Linux/Windows/macOS app packages avoid bundling `/usr/bin/node` to prevent system conflicts (system Node.js >=22 may be required) | MIT |
| `@kenkaiiii/gg-*` packages | agent framework/core in the sidecar (`showcase/tauri/sidecar/package.json`) | see package licenses |
| [zod](https://zod.dev) | schema validation in the sidecar | MIT |
| [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | Claude integration support in the sidecar | Proprietary: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." |
| Claude Code | may be downloaded/configured for Claude sign-in flows (not necessarily bundled) | Anthropic terms |
| Doto / Martian Mono fonts | UI text/fonts in shared assets (where present) | SIL OFL 1.1 (see bundled font license files where applicable) |
| [Natural Earth](https://www.naturalearthdata.com) 1:110m countries | map/country data where used | Public domain |
| NVIDIA Parakeet TDT 0.6B v3 and ONNX exports | speech model (downloaded when needed, not necessarily bundled) | see upstream licenses (e.g. CC BY 4.0 for model/export as applicable) |
| [parakeet-rs](https://github.com/altunenes/parakeet-rs) | voice helper speech inference (voice-win) | MIT OR Apache-2.0 |

## Full dependency list

To inspect all dependencies, including transitive ones:

```bash
cd showcase/tauri/sidecar && npm ls --all
cd showcase/tauri/src-tauri && cargo tree
cd showcase/tauri/src-tauri/voice-win && cargo tree
```
