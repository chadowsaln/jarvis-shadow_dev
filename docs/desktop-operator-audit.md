# JARVIS V2 — Desktop Operator: Batch 0 Architecture Audit

Date: 2026-11-19 · Scope: whole desktop-control surface of the repo · No source files modified.

Status legend: **Working** (exercised by tests and/or the live app), **Partial** (exists, limited),
**Stub** (returns success without doing the work), **Broken** (fails at runtime), **Absent**.

---

## 1. Method

Read, in full: `sidecar/agentcore/*` (10 modules, 1.47k lines), `sidecar/computer-control/*`
(6 modules, 421 lines), `sidecar/safety.mjs`, `screen.mjs`, `pointing.mjs`, `browser.mjs`,
`sysinfo.mjs`, `activity.mjs`, `tools.mjs` (1,942 lines, tool registry + all tool bodies),
`sidekick.mjs` (agent wiring, IPC, approval), `src-tauri/src/sidecar.rs`, the hands helper
command surface (`hands/main.swift`, `hands-win/src/main.rs`), `panel/panel.js` + `panel/approval.js`,
`JARVIS_V2_SPEC.md`, and `package.json` scripts.

Verified empirically (read-only):

- `npm test` in `showcase/tauri/sidecar` — **baseline green** (all 68 files, exit 0).
- Built the real tool list via `createTools(...)` and inspected permission metadata (58 tools on Linux).
- Probed the live AT-SPI accessibility bus with `dbus-next` (result in §5.3).
- Checked the host: Wayland session, `ydotool`/`ydotoold` installed but **no daemon socket**,
  **no `tesseract` binary**, `xclip`/`wl-paste` present, session bus up.

Not done in this phase (by design): no tool execution against the user's desktop, no file writes,
no capture of the screen.

---

## 2. What the architecture actually is

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Tauri 2 shell (Rust)  src-tauri/src/*.rs                                 │
│  • windows: panel, overlay, onboarding; tray; hotkeys; overlay hit-rects  │
│  • spawns the sidecar (sidecar.rs) with ROAMIES_HANDS=<helper path>      │
│  • linux.rs: X11 overlay, portal screenshot, clipboard, set_hit_rects    │
│  • hands helpers are separate binaries, spawned by the sidecar:          │
│      macOS  hands/main.swift        (Accessibility / CGEvent / Vision)   │
│      Windows hands-win/             (UIA / SendInput / Windows OCR)      │
│      Linux  — none                                                       │
└───────────────▲──────────────────────────────────┬───────────────────────┘
                │ JSON Lines on stdio              │ sidecar_send / sidecar_stdout
┌───────────────┴──────────────────────────────────▼───────────────────────┐
│ Node sidecar (sidekick.mjs) — the agent process                          │
│  • stdin line loop (sidekick.mjs:2540) → message dispatch                │
│  • createTools() builds the model's tool list (tools.mjs)                │
│  • @kenkaiiii/gg-agent runs the loop; providers in providers.mjs         │
│  • activity.mjs → panel activity lines; plan trail on `plan_steps`       │
│  • agent core (OFF unless ROAMIES_AGENT_CORE=1), sidekick.mjs:663-682    │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ every file / command / URL / app / click goes through
        safety.mjs (SAFE | ASK | BLOCK, classifyCommand, checkAppTarget, …)
```

Control loop **today**: the model decides one tool call at a time; the tool does the work and
returns text (or an image) to the model; the model decides the next call. There is no separate
executor loop, no plan object in the live path, and no verification step.

### 2.1 Agent core (exists, tested, disabled by default)

`agentcore/` is a complete authorization **boundary**, not a second agent:

| Module | Role | State |
|---|---|---|
| `permissions.mjs` | 5 levels (observe…administrative), fingerprint of (tool,args,context), single-use approval store, TTL, revoke | Working, tested |
| `router.mjs` | deny-by-default, metadata required in strict mode, level check, safety preflight, arg validation | Working, tested |
| `executor.mjs` | route → approval → pre-execute recheck → fingerprint binding → consume → run → cancel/revoke; logs every step | Working, tested |
| `planner.mjs` | plan/step state, dependencies, blocked-on-failure, cancel | Working as a library; **not used by the live agent** |
| `approval-channel.mjs` | transport to the panel, redaction, expiry, one live dialog per action | Working, tested, UI wired (`panel/approval.js`) |
| `preflight.mjs` | re-uses `safety.mjs` checks at both route and pre-execute | Working, tested |
| `runtime.mjs` | wraps the tool list so no tool is reachable around the router | Working, tested |
| `intent.mjs`, `context.mjs` | heuristic intent, token budget (delegates to `store.mjs`) | Partial / thin |

This is the strongest asset in the repo and the correct execution layer for everything below.
**It must be extended, never duplicated.** Its two problems are configuration, not design (§4.1).

---

## 3. Capability matrix (against the request)

### A. Mouse

| Capability | Status | Evidence |
|---|---|---|
| Move to absolute coordinates | Partial | `input-simulation.mjs` `move` (Linux, ydotool); hands `click_at` (mac/win) |
| Move relative | Absent | — |
| Left click | Working | hands `click`/`click_text`/`click_at`; `linux_click_element` |
| Right click / middle | Absent (Linux partial) | `linux_click_element` maps `button` to ydotool codes; nothing on mac/win, and no model-facing arg for it |
| Double click | Absent | grep: no `double` anywhere in hands or tools |
| Click and hold | Absent | — |
| Drag and drop | Absent | hands only has *UI selection* drags, not input drags |
| Scroll vertical | Working | hands `scroll` (element or page, `to_end`); ydotool wheel |
| Scroll horizontal | Absent (hands partial) | ydotool branch sends `--wheel 0 -dy` only |
| Multiple monitors | Partial | global screen coordinates; no monitor enumeration/validation |

### B. Keyboard

| Capability | Status | Evidence |
|---|---|---|
| Type text | Working | hands `type`/`fill`/`set` (native field writes + real keystrokes for web fields, then verifies the value); `linux_type_text` (ydotool) |
| Shortcuts / key combos | Working | hands `pressKey`, menu-item routing (`shortcutRoute`), `withRealCursor`; `linux_press_key` `hotkey` |
| Special/navigation keys | Working | key tables in both helpers; `KEY_MAP` in `input-simulation.mjs` |
| Arabic input | Partial | macOS CGEvent unicode typing handles it; ydotool types by keycode and is unreliable for non-Latin |
| Selection/copy/paste/edit | Partial | only via keys; clipboard read not exposed (see G) |

### C. Application management

| Capability | Status | Evidence |
|---|---|---|
| Discover installed apps | Working | `list_apps`/`find_app` (desktop entries on Linux, LaunchServices/registry elsewhere) |
| Launch | Working | `launch_app`, with `checkAppTarget` (never a path/script/shell) and confirm |
| Close application | **Absent** | no tool, deliberately; needed for "close the apps I'm not using" |
| Switch to running app | Working | `act_in_app` raises/focuses the app's window |
| Active app / window | Working | hands `front`; `locate` returns front app + window + bounds |
| Process info | Partial | `running_apps`, `system_status` top processes; no per-app pid ownership, no kill |
| Launch failure handling | Working | helpers report; `act_in_app` auto-launches then retries |
| Multiple apps in one task | Partial | model-driven, one call at a time; no orchestration state |

### D. Window management

| Capability | Status | Evidence |
|---|---|---|
| Enumerate | Working | hands `windows`; `linux_list_windows` (AT-SPI, see §5.3) |
| Focus | Working | `act_in_app` implicit; `linux_focus_window` (AT-SPI GrabFocus) |
| Minimize / maximize / resize / reposition | **Absent** | nowhere in the codebase |
| Window state detection | Partial | `bounds`, front flag; no minimized/occluded state |
| Multi-monitor | Partial | bounds only |
| "Move this window to the second monitor" | Absent | not possible with the current commands |

### E. File system

Working: `list_files`, `find_files`, `search_files` (regex over content), `file_info`, `read_file`
(text only), `write_file`, `create_directory`, `copy_file`, `move_file`, `rename_file` — all
confined to allowed folders through `safety.mjs`, mutating ones confirm per operation.

Absent / limited: **delete** (intentionally absent — must stay approval-gated if added), PDF/DOCX/
XLSX/EPUB reading, archive handling, trash/restore, size/space preflight, batch operations,
duplicate detection, watching.

### F. System control

| Capability | Status |
|---|---|
| CPU/memory/disk/battery/top processes | Working (`sysinfo.mjs`, read-only, tested) |
| Volume / audio device control | **Absent** (`pactl` only used for diagnostics) |
| Brightness | Absent |
| Display configuration | Absent |
| Network status | Absent (only `system_status` fields) |
| Bluetooth status | Absent |
| Running processes / kill | Read-only list; no kill |
| System settings | Absent (only `open_settings` for permission panes) |

### G. Clipboard

Write-only (`copyText`: `xclip`/`pbcopy`/`Set-Clipboard`, Linux through the shell). **No read**, no
paste-into-app abstraction beyond typing, no preservation/restore.

### H. Screenshot & screen awareness

| Capability | Status | Evidence |
|---|---|---|
| Capture full screen | Working | hands `capture` (mac/win); `take_screenshot` |
| Capture specific window/app | Working (mac/win) | hands `capture <file> window:<id>` / `app:<name>` |
| Capture on Linux | Partial | XDG portal **interactive every time** (`screen.mjs`, `dbus-integration.mjs`) → unusable inside a loop |
| Send image to the model | Working | `take_screenshot`, `see_photo` |
| Element detection | Working (mac/win) | Accessibility tree: `read_window`/`ui`/`locate-control`; OCR + text finding (`find-text`, `ocr-find`) |
| Element detection on Linux | **Broken** | §5.3 |
| Dynamic target location (not hardcoded coords) | Working (mac/win) | `click_text` by visible words, `snapRect`/`fitBox` pixel fitting, `rematch` for stale ids |
| Diff / change detection between shots | Absent | `pageSig` compares signatures inside a wait only |
| Verification of an action's effect | Partial | helpers re-read the window and return controls after `act`; nothing verifies in the agent loop |

### I. Autonomous task execution

| Capability | Status |
|---|---|
| Understand a multi-step objective | Model-side only |
| Break into steps | `plan_steps` → **cosmetic trail** in the panel (`sidekick.mjs` `trail`), no plan object |
| Dependencies / ordering | `agentcore/planner.mjs` supports it; live path never creates multi-step plans |
| Retry policy | Absent (only `relaunch-then-retry` inside `act_in_app`) |
| Timeouts | Per-tool `timeoutMs` only (`draw`, `act_in_app`) |
| Cancellation | Per-turn stop; executor has `cancel()`/`revoke()` but is not wired to the stop button |
| Recovery | Absent (helper-level fallbacks only) |
| Progress reporting | Activity lines + cosmetic trail |
| Persistent task context | Absent (conversation only) |
| Verification before "done" | **Absent** — `computer-control/verification.mjs` returns `not_implemented` |

### J. Multi-application orchestration

Model-driven through single calls; `act_in_app` batches steps **within one app** with fresh ids
after each click. No cross-app transaction, no shared task state, no "wait until app is ready"
beyond the helper's own window checks.

### K. Browser

No browser automation (no CDP/WebDriver). `browser_*` = open a URL, read a page through fetch,
Respan local bridge reads. In-page clicking is only possible through the accessibility layer
(`act_in_app`) on mac/win, and is broken on Linux.

---

## 4. Permission & safety findings

### 4.1 P0 — the capable path and the safe path are disjoint

Measured against the real tool list (Linux, no hands helper; macOS/Windows additionally build the
hands tools): **58 tools, 14 without permission metadata.** The agent core refuses to offer any
tool without metadata (`runtime.mjs` filters, and `agentapproval.test.mjs` asserts the exact
reviewed set). Those 14 include:

```
take_screenshot, draw, see_photo, run_command, web_search, web_fetch, open,
remember_commitment, update_commitment, forget_fact, plan_steps, show_list,
pomodoro, morse_practice
```

plus, on macOS/Windows, **`act_in_app`** and **`read_window`** (only `list_windows` carries metadata).

Consequence: turning on `ROAMIES_AGENT_CORE=1` — the documented goal of V2.1 — **removes screen
capture, action-in-app, open, run_command and web access from the agent**, i.e. it disables the
desktop operator. Nobody noticed because the secure set is only tested for *itself*.

### 4.2 P0 — with the flag off, per-call approval metadata means nothing

`permission: { requiresApproval: true }` is consumed **only** by the router/executor. With the flag
off (the default), the tool list is handed to the model untouched, so:

- `linux_click_element`, `linux_type_text`, `linux_press_key`, `linux_move_mouse` execute with **no
  confirmation at all**, despite declaring `sensitive + requiresApproval`;
- `act_in_app` asks only for *risky-worded* clicks (`isRiskyClick`) — any other click, fill, `set`,
  `key`, `choose` runs silently;
- `linux_ocr` / `linux_capture_screen` rely on the portal's own consent dialog (acceptable, but not
  guaranteed and absent on X11).

Tools that do ask today: `write_file`, mutating file ops, `run_command` (classifyCommand → ASK),
`launch_app`, risky label clicks.

### 4.3 What is genuinely good

- `safety.mjs` is the single choke point for files/commands/URLs/apps, with blocklists for
  secret-bearing files, system roots, shells, package managers, private IPs, and every rule has tests.
- `HANDS_OFF` (terminal emulators, Keychain, Settings, password managers, Automator) is enforced in
  both helpers, by bundle id and by program name.
- Risky-click vocabulary is multilingual and enforced **inside** the helper too, so a bug in the
  sidecar still cannot click "Delete" without `confirmed: true`.
- Approval binding is real: fingerprint over normalized args, single use, TTL, revocation,
  request-id/tool/fingerprint mismatch all fail closed, panel redacts secrets and caps size.
- `redactArgs` + activity lines never leak paths, commands, or typed text.

### 4.4 Other security notes

- `run_command` remains the widest surface (free-form shell, ASK-gated, no sandbox). Any autonomous
  planner should prefer typed tools and treat `run_command` as last resort.
- Screenshots leaving the machine: `take_screenshot` returns an image to a cloud model with no
  consent gate of its own. The request explicitly forbids sending screen content to the cloud
  without permission — needs an explicit, per-session policy.
- `screen_capture`/`screen_ocr` check `process.platform === 'linux'` in preflight but the tools are
  only built on the platforms where they make sense; on Linux the portal picker is the consent.
- Deleting files is absent — good default. If added, it belongs at `sensitive` + approval + trash.

---

## 5. Reuse map and defect list

### 5.1 Reuse, do not rebuild

| Need | Reuse |
|---|---|
| Authorization, approval, single-use binding, recheck | `agentcore/{router,executor,permissions,approval-channel,runtime}.mjs` |
| Safety rules for files/commands/URLs/apps | `safety.mjs` (+ `agentcore/preflight.mjs`) |
| Desktop control on macOS/Windows | hands helpers' existing commands (`windows`, `locate`, `capture`, `ui`, `read_window`, `act`, `find-text`, `ocr-find`) |
| Screenshot → model coordinate mapping | `pointing.mjs` (`shotMap`, `shotFits`, `snapRect`, `rematch`, `shotProblem`) |
| Activity/progress text | `activity.mjs` |
| Permission + approval UI | `panel/approval.js`, `panel/panel.js:1136-1190` |
| Token/context budget | `agentcore/context.mjs` → `store.mjs` |
| System readings | `sysinfo.mjs` |
| Tool schema conventions | `zod` objects, `resolveToolSchema`, tested by `toolschema.test.mjs` |

### 5.2 Missing (build here, in existing modules)

Window manipulation tool; close/quit app; mouse drag/double/right/hold; relative move; monitor
enumeration; clipboard read; volume/brightness/network/bluetooth; delete (gated); PDF/office read;
Linux capture without a picker each time; screen diff; verification steps in the executor;
real plan objects in the live loop; cross-app task context; retry/timeout/cancel semantics.

### 5.3 Defects found (not scaffolding — broken code)

> **All of these are fixed** — see [desktop-operator-batch3.md](desktop-operator-batch3.md) for
the rewrite and the live evidence.

1. **`computer-control/atspi-adapter.mjs` is written against an imagined AT-SPI API.**
   Live probe on this machine:
   ```
   a11y bus address: unix:path=/run/user/1000/at-spi/bus
   a11y probe failed: acc.GetChildCount is not a function
   ```
   `ChildCount`/`Name`/`Role` are **properties** in `org.a11y.atspi.Accessible`, not methods;
   `GetApplication()` does not exist (the pid comes from `org.a11y.atspi.Application`).
   With no `GetChildCount`, `getApplicationList()` returns `[]`, so `getWindowList()`,
   `findElements()` and therefore `linux_click_element` return nothing. Every Linux control tool is
   non-functional, silently.
2. **`linux_ocr` is a stub.** It requests a screenshot and returns
   `"OCR requested via portal. Result URI: … Language: eng+ara"` — it never OCRs. `ocr-adapter.mjs`
   (tesseract.js) exists and is unused; `screen.mjs` needs the `tesseract` **binary**, which is not
   installed here.
3. **`linux_capture_screen` returns a portal URI with no pixels** — nothing to show the model.
4. **`input-simulation.mjs` never checks the ydotoold socket.** `isAvailable()` does
   `fs.access(...).catch(() => {})` and always returns `true`. On this host the socket
   `/run/user/1000/.ydotool_socket` does not exist, so every call fails at runtime while the
   capability probe says input is available.
5. **`verification.mjs`** reports `{ ok: true, note: 'not_implemented' }` for anything that is not
   `file_exists` — a false success, exactly what the request forbids.
6. **`linux_move_mouse`/`input.move(x, y, durationMs)`** — duration is accepted and ignored.
7. **Wheel-only, vertical-only scrolling** in the ydotool backend; horizontal is silently dropped.
8. `detectCapabilities()` in `computer-control/index.mjs` sets `ocr: true` unconditionally.

---

## 6. Environment facts measured (this machine)

- Session: **Wayland** (`XDG_SESSION_TYPE=wayland`, `DISPLAY=:0` via XWayland).
- `ydotool`, `ydotoold` installed; **no daemon socket** → input simulation unusable until
  `ydotoold` runs with a socket the app can reach.
- **`tesseract` binary absent** → `screen.mjs` OCR path fails; `tesseract.js` present but its
  language data would have to be fetched.
- AT-SPI registry reachable: `unix:path=/run/user/1000/at-spi/bus`; adapter broken as above.
- `xclip`, `wl-paste`, `xdotool`? (`xdotool` absent) — clipboard write works via `xclip`.
- Node 22.23.1; `npm test` green (exit 0).

---

## 7. Implementation plan

Batches are independently verifiable; each ends with tests + a report. **No batch starts before the
previous one is green.** Everything routes through the existing router/executor/approval channel and
`safety.mjs`; nothing gets a parallel permission or tool registry.

### Batch 1 — Unify the execution path (P0, blocks everything)

Goal: one path — every tool the model can call is a tool the agent core authorizes, at both ends.

1. Add `permission` metadata to all 14 (+`act_in_app`, `read_window`) tools, classified honestly:
   - `observe`: `take_screenshot`, `web_search`, `web_fetch`, `open`, `plan_steps`, `show_list`,
     `list_windows`, `read_window`, `see_photo`, `draw` (draw only when it has no `type`/`open`
     action — else `trusted`+approval), memory reads.
   - `trusted` + approval: `run_command` (keep existing confirm), `remember_commitment`,
     `update_commitment`, `forget_fact`, `pomodoro`, `morse_practice`, `act_in_app`.
2. Make the default safe: `ROAMIES_AGENT_CORE=1` on by default with `ROAMIES_AGENT_CORE_LEVEL`
   defaulting to **`assist`** (not `observe`), so the operator works out of the box and every
   `trusted`+ action still asks in the panel. Keep an explicit `=0` escape hatch.
3. Wire the panel's Stop to `executor.cancel()` and `revoke()`; wire turn-level `signal` into
   `runTool`.
4. Add a screen-sharing consent policy for image-returning tools (`take_screenshot`, `see_photo`):
   ask once per session, remember the decision, surface it in settings.

Tests: extend `agentapproval.test.mjs` / `toolschema.test.mjs`; new assertions —
every tool in `createTools()` has metadata; the offered set equals the full tool set ("nothing
silently dropped"); flag-off path now fail-closed for `sensitive` tools; stop/cancel fans out.

Acceptance: with the flag on at `assist`, a screenshot → act_in_app → read_window round trip is
possible; `sensitive` tools are denied until the level or an approval allows them; no tool list
regression (`toolschema` green).

### Batch 2 — Desktop control foundation (typed action layer)

> **Done (2026-11-20)** — see [desktop-operator-batch2.md](desktop-operator-batch2.md). The adapter
> layer and tools exist; Linux control still depends on Batch 3.

New module `sidecar/desktop/` — **adapters only**, no policy, no approvals:

```
desktop/index.mjs        capability detection + backend selection (hands | atspi+x11 | xdotool/ydotool)
desktop/input.mjs        move/relative, click(left|right|middle), doubleClick, down/up, drag, scroll(x,y), type, key, hotkey
desktop/windows.mjs      list, focus, minimize, maximize, restore, move(x,y), resize(w,h), monitors()
desktop/apps.mjs         list, find, launch, quit, front
desktop/clipboard.mjs    read, write, preserve/restore
desktop/verify.mjs       real conditions: file_exists, window_focused, window_title, element_present, text_present, clipboard_equals, image_changed
```

Backends: `hands` on macOS/Windows (extend the helpers with the missing verbs: `click --button`,
`double`, `drag`, `hold`, `move`, `window minimize|maximize|restore|move|resize`, `quit`,
`clipboard get|set`, `monitors`), X11/AT-SPI on Linux (fixed per §7.1) or the app's own Rust
commands where GTK/X11 is already linked. Every verb goes through `safety.mjs` and
`HANDS_OFF`-equivalent denials.

New tools (metadata from Batch 1 conventions): `desktop_click`, `desktop_drag`,
`desktop_scroll`, `desktop_type`, `desktop_key`, `window_list`, `window_control`,
`app_quit`, `monitors`, `clipboard_read`, `clipboard_write`.

Tests: unit tests with a **fake backend** that records calls (no real input); `HANDS_OFF` refusal
tests; coordinate/monitor math tests; helper `--self-test` additions for the new verbs.

### Batch 3 — Linux control actually works

> **Done (2026-11-20)** — see [desktop-operator-batch3.md](desktop-operator-batch3.md). The AT-SPI
> adapter, input probes, capture, OCR and verification are real; capabilities report the truth.

Fix §5.3 properly, on X11 and Wayland:

1. Rewrite the AT-SPI adapter against the real spec: read `ChildCount`/`Name`/`Role` **properties**,
   use `GetChildAtIndex` structs, `org.a11y.atspi.Application` for pid, `Component.GetExtents`,
   `Action.GetActions`/`DoAction`, `Text` for field values. Cache the app tree; cap depth.
2. Input backend order: XTest (X11) → libei/XWayland path → ydotool **only if** the socket answers
   a real round-trip (fix `isAvailable`), else report `unavailable` with the exact remediation.
3. Capture: prefer the shell's `linux::screenshot` path for a **non-interactive** capture when the
   portal grants a persistent permission (portal `SelectSources`/restore token), fall back to the
   interactive picker with a clear message.
4. OCR: tesseract.js with `eng`+`ara` data, or the binary when present; **remove the stub**.
5. Verification: implement the real conditions; delete the `not_implemented` success path.

Tests: adapter tests against a fake D-Bus/proxy object; input backend selection matrix; OCR stub
removal asserted (a call without a real image must error, never "ok"); `capabilities` reports the
truth (this host: `input: unavailable`, `ocr: unavailable`).

### Batch 4 — Screen awareness & visual targeting

- `screen_look` tool: capture (window/app/screen) → downscale via `pointing.mjs` mapping → optional
  local OCR → return elements + text with coordinates the model may use; refuse stale shots.
- Screen diff: hash/compare regions to answer "did it change?" and to verify an action.
- Element search that prefers accessibility, falls back to OCR/pixels — one API, three strategies,
  cheapest first (explicitly to avoid screenshot spam and vision cost).
- Cache: one capture per action, reuse until the screen changes.

### Batch 5 — Files, clipboard, system control

- `delete_file` (sensitive + approval, trash-first, never recursive without a second approval).
- Read PDF/DOCX/XLSX/EPUB via a small extractor (reuse the project's existing deps if any; else
  add one — research before choosing).
- Clipboard read/paste/preserve (`pactl`/`xclip`/`wl-paste` on Linux, helpers elsewhere).
- System control: volume up/down/mute/set + input/output device, brightness (where the OS exposes
  it), network status, bluetooth status, process list + `process_kill` (sensitive + approval).
  All read-only verbs `observe`, all mutating verbs `trusted`+, none shelled through `run_command`.

### Batch 6 — Autonomous task execution on the existing executor

- Replace the cosmetic `plan_steps` with real plans: a `make_plan` tool that creates an
  `agentcore/planner.mjs` plan (goal + steps with `dependsOn`, per-step `verify`, `retries`,
  `timeoutMs`, `onFailure`), executed by `executor.runReadySteps`.
- Step results feed back as observations; verification must pass before a step is `completed`;
  two failed verifications → step fails with the observed state attached.
- Retry with backoff; per-step timeout; global cancel; resume from persisted plan
  (`store.mjs`, SQLite already available via `better-sqlite3`).
- The panel shows the plan from the real object (reuse the existing trail UI).

Tests: planner+executor integration with a fake tool set; dependency ordering; retry/backoff;
timeout; cancel mid-plan; verification failure; resume after restart.

### Batch 7 — Multi-application orchestration

- A task context object (current app, window, file, clipboard ownership, open downloads) carried
  across steps and injected into the planner's observation.
- Ready-wait primitive ("app is open, focused, its window has controls") instead of fixed sleeps.
- Cross-app steps: copy from A → verify → switch to B → paste → verify (`clipboard` + `verify`).
- Guard rails: never type into a window that is not the intended one (reuse the helper's
  `borrowVerdict` idea), never act while the user is typing (existing `ink`/input checks).

### Batch 8 — Permission & security hardening

- Risk taxonomy mapped to the five levels, documented next to each tool; `sensitive` for delete,
  quit, kill, install, settings; `administrative` only for privileged/system changes.
- Approval UX: scope display ("this click, this app, this run"), approve-once vs approve-for-task,
  expiry countdown, redacted preview.
- Screen-content egress policy enforced centrally (one gate for every image-returning tool).
- Adversarial tests: page/app content cannot grant permissions; a tool call cannot widen its own
  level; approval replay/mismatch/expiry; `HANDS_OFF` bypass attempts; prompt-injection fixture
  where a web page says "click Pay" (must still ask).

### Batch 9 — Integration, reliability, acceptance

- End-to-end scripted scenarios on a controlled desktop (fake backend + one real smoke run):
  "open the browser, find the docs, download the PDF, move it into ~/dev, verify";
  "close unused apps"; "run the project's tests in a terminal".
- Sidecar lifecycle: crash/restart, helper missing, permission revoked mid-task, IPC line
  corruption, cancel storms.
- CI: keep `npm test` green; add the new suites; keep `cargo test` for hands-win `logic.rs`.

---

## 8. Decisions (answered 2026-11-19)

1. **Batch 1 as planned** — approved, and done (see [desktop-operator-batch1.md](desktop-operator-batch1.md)).
2. **Default level `trusted`** — reading, clicking, typing, files and app launches work; `sensitive` and
   `administrative` stay denied. Residual risk (silent typing/clicks) is tracked for Batch 8.
3. **Approve every capture** — `take_screenshot` asks on every call; no session-wide consent.
4. **Batch 2, then Batch 3** — the adapter layer defines the interface the Linux backend implements.

## 8.1 The original questions, for the record

1. **Default level for the agent core.** I propose `assist` (screen reading, window focus, typing
   with approval on `trusted`+). Alternative: stay `observe` (nothing actually happens until the
   user raises the level manually).
2. **Screen egress.** May screenshots go to the configured cloud model after a one-time session
   consent, or must every capture be approved individually?
3. **`run_command`.** Keep it available to the planner (it is the widest hole) or restrict it to
   interactive turns with approval?
4. **Linux first or parity first?** Linux control is currently non-functional and needs a rewrite
   (Batch 3); macOS/Windows are strong but lack window/mouse verbs (Batch 2). Doing 2 before 3 gives
   parity quickly; doing 3 first makes the app actually usable on this machine.

---

## 9. Deliberately not in this plan

- No OBS/streaming/GTA/Discord features.
- No parallel agent core, permission manager, tool registry or task framework.
- No screenshot-only automation: accessibility is always tried first.
- No local large models: planning/vision stay on the configured cloud providers.
- No destructive test against the real desktop or real files.
