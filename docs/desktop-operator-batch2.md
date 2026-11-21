# Batch 2 — Desktop control foundation (typed action layer)

Date: 2026-11-20 · Follows [desktop-operator-audit.md](desktop-operator-audit.md) (Batch 0) and
[desktop-operator-batch1.md](desktop-operator-batch1.md) (Batch 1) · Status: **complete for the adapter layer and tools; helpers extended; Linux backends still gated by Batch 3**

Goal: one typed desktop interface with the verbs the audit listed as missing — relative move,
right/middle click, double click, press-and-hold, drag, horizontal scroll, window
minimize/maximize/restore/move/resize, monitors, quit app, clipboard read — plus new tools that use
them, all at permission levels that already work under the default `trusted` grant.

---

## 1. What was implemented

### 1.1 `sidecar/desktop/` — adapters only, no policy

| File | Role |
|---|---|
| `desktop/index.mjs` | `createDesktop({ input, windows, apps, clipboard })` (injectable backends, used by tests); `createDesktopFromEnvironment()` picks hands on macOS/Windows and computer-control on Linux; `detectCapabilities()` |
| `desktop/input.mjs` | move, relative, click (left/right/middle), double click, down/up, drag, scroll (x and y), type, key, hotkey. Falls back to two clicks or down/move/up when a backend lacks a primitive |
| `desktop/windows.mjs` | list, focus, minimize, maximize, restore, move, resize, monitors |
| `desktop/apps.mjs` | list, find, launch, quit, front |
| `desktop/clipboard.mjs` | read, write, preserve/restore (keeps one saved value per adapter) |
| `desktop/verify.mjs` | **real** conditions: `file_exists`, `file_contains`, `window_focused`, `window_title`, `element_present`, `text_present`, `clipboard_equals`, `image_changed`. Unknown types and missing backends fail closed — the old `not_implemented` success path is gone from this layer |
| `desktop/linux-backend.mjs` | input via `computer-control/input-simulation` (ydotool), windows/apps via AT-SPI, window control via `wmctrl`, monitors via `xrandr`, clipboard via `wl-paste`/`xclip` |
| `desktop/hands-backend.mjs` | macOS/Windows: spawns the hands helper for every verb |

Backends are objects, not imports, so a recording fake proves the contract without touching the
real desktop.

### 1.2 New tools (all platforms)

| Tool | Level | Asks | Backend verb |
|---|---|---|---|
| `desktop_click` | trusted | no | input.click / doubleClick |
| `desktop_drag` | trusted | no | input.drag |
| `desktop_scroll` | assist | no | input.scroll |
| `desktop_type` | trusted | no | input.type |
| `desktop_key` | trusted | no | input.key / hotkey |
| `window_list` | observe | no | windows.list |
| `window_control` | trusted | no | focus/minimize/maximize/restore/move/resize |
| `app_quit` | **sensitive** | **yes** | apps.quit (checks the off-limits apps on Linux first) |
| `monitors` | observe | no | windows.monitors |
| `clipboard_read` | observe | no | clipboard.read |
| `clipboard_write` | trusted | no | clipboard.write |

Typing, clicking, dragging and scrolling on Linux go through the same
`checkLinuxInputTarget` guard the existing `linux_*` tools use, so a terminal, Settings or a
password manager is refused before any input is posted.

### 1.3 Native helpers

- **macOS `hands/main.swift`** — new commands: `move` (`--relative`), `click` (`--at`,
  `--button`), `double`, `mousedown`, `mouseup`, `drag`, `scroll` (`--dx`, `--dy`), `type`,
  `key`, `focus`, `window minimize|maximize|restore|move|resize`, `quit`, `apps`, `clipboard
  get|set`, `monitors`. Uses the helper's existing CGEvent/typeText/pressKey/scrollAt primitives
  and AX position/size/minimized attributes.
- **Windows `hands-win`** — matching commands in `main.rs`, built on the existing
  `act::move_to/click/type_text/press_key/wheel` plus `ShowWindow`/`SetWindowPos`, `taskkill`,
  PowerShell `Get-Clipboard`/`Set-Clipboard`, and `win::monitors`.
- **Fixed a pre-existing Windows compile break**: `act.rs` and `win.rs` called `is_roamies`, which
  no longer exists; both now call `is_littleboy`. `cargo check --target
  x86_64-pc-windows-msvc` now passes with the new code.

---

## 2. Files

Created: `sidecar/desktop/{index,input,windows,apps,clipboard,verify,linux-backend,hands-backend}.mjs`,
`sidecar/test/desktop.test.mjs`, this report.

Modified: `sidecar/tools.mjs` (desktop factory + guard + 11 tools), `sidecar/package.json`
(`desktop.test.mjs` in `npm test`), `sidecar/test/agentapproval.test.mjs` (reviewed set and the new
levels), `hands/main.swift`, `hands-win/src/main.rs`, `hands-win/src/act.rs`,
`hands-win/src/win.rs`.

---

## 3. Tests executed

- `node test/desktop.test.mjs` — fake backend: every verb reaches the backend; double-click and
  drag fall back correctly; a backend without `relative` errors instead of pretending; clipboard
  preserve/restore; every verify condition succeeds and fails on its real evidence; unknown
  condition and missing backend fail closed.
- `npm test` in `showcase/tauri/sidecar` — full suite, exit 0, including `desktop.test.mjs`,
  `toolschema.test.mjs` and `agentapproval.test.mjs` (offered set = reviewed set, new levels
  asserted).
- `npm run build` — esbuild bundle, exit 0.
- Live tool probe on this host: `desktop_*`, `window_*`, `app_quit`, `monitors`,
  `clipboard_*` are offered; `clipboard_write` → `clipboard_read` round-tripped the real
  clipboard text.
- `cargo check --target x86_64-pc-windows-msvc` in `hands-win` — clean.
- `swiftc -parse main.swift` — clean (type-checking needs AppKit, unavailable on Linux).

---

## 4. Known limitations

- **Linux control is still Batch 3.** `window_list`, `desktop_click` and friends call the same
  AT-SPI/ydotool path the audit found broken. `monitors` needs `xrandr` (absent on this Wayland
  host) and returns a clear error. `app_quit` uses `pkill -f`, which is broader than the audit's
  ideal and should move to a pid-keyed quit in Batch 3/8.
- **Helpers are unverified at runtime.** The macOS Swift only parsed here, and the Windows Rust
  only type-checked. No click, window move or clipboard call was exercised on a real Mac or
  Windows desktop.
- `desktop.mjs`'s `verify` is a standalone service; the executor does not yet call it before a
  step is marked done. That wiring belongs to Batch 6.
- `window_control` and `desktop_*` are `trusted` and silent at the default grant, matching the
  existing `act_in_app`/`linux_*` decision. The residual risk is unchanged and tracked for Batch 8.
- Windows `quit` shells out to `taskkill`, and clipboard uses PowerShell; both are deliberate
  shortcuts, not typed Win32 calls.

## 5. Next

Batch 3: make the Linux backends real (rewrite AT-SPI against the spec, fix the ydotoold socket
check, non-interactive capture, real OCR, delete the `not_implemented` verification path).
