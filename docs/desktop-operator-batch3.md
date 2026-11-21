# Batch 3 — Linux control actually works

Date: 2026-11-20 · Follows [desktop-operator-audit.md](desktop-operator-audit.md) (Batch 0),
[desktop-operator-batch1.md](desktop-operator-batch1.md) and
[desktop-operator-batch2.md](desktop-operator-batch2.md) · Status: **complete**

Goal: fix the defects in §5.3 of the audit — a rewritten AT-SPI adapter, an honest ydotoold check,
real capture and OCR, and no `not_implemented` verification success.

---

## 1. AT-SPI adapter rewritten against the real interfaces

[atspi-adapter.mjs](../showcase/tauri/sidecar/computer-control/atspi-adapter.mjs) now speaks the
documented D-Bus API (checked against the Ubuntu AT-SPI reference and `at-spi2-core`):

- `Name`, `Description`, `ChildCount`, `Parent`, `Locale`, `Attributes` are read as **properties**
  through `org.freedesktop.DBus.Properties` — never called as methods.
- Children come from `Accessible.GetChildren` (a real method), with a fallback to the
  `ChildCount` property plus `GetChildAtIndex` when an implementation refuses `GetChildren`.
- The application list is the registry root's **direct** children (the old code walked an extra
  level); each app's `ToolkitName`/`ToolkitVersion` come from `org.a11y.atspi.Application`.
- The process id comes from `org.freedesktop.DBus.GetConnectionUnixProcessID(bus_name)`, not the
  non-existent `Accessible.GetApplication`.
- Roles use `GetRoleName` normalized to `ROLE_*` (so `"push button"` becomes `ROLE_PUSH_BUTTON`),
  with a `GetRole` id fallback table.
- States decode `Accessible.GetState`'s `au` bit words into `STATE_ACTIVE`, `STATE_VISIBLE`, …
- `Action.NActions` is read as a property; `GetName(i)`/`DoAction(i)` are methods.
- Text fields expose their value through `org.a11y.atspi.Text.GetText(0, -1)`.
- Bounds come from `Component.GetExtents(0)`; focus from `Component.GrabFocus`.
- App/window/tree results are cached briefly (1.5 s), depth is capped at 8 and elements at 400.

Verified live on this host: `getApplicationList()` returned 3 applications with pids and toolkit
names, `getWindowList()` returned the amberol window with bounds and states, and `findElements({})`
returned 12 elements with normalized roles and the window's real Action names. The audit's probe
failure (`acc.GetChildCount is not a function`) is gone.

## 2. Input: honest backend selection

[input-simulation.mjs](../showcase/tauri/sidecar/computer-control/input-simulation.mjs) now has two
backends with real probes:

- `xdotool` (XTest) when `DISPLAY` is set and the binary exists.
- `ydotool` only when the binary exists **and** the socket exists, is a Unix socket, and accepts a
  connection. Missing socket, non-socket, refused connection and missing binary each return a
  different reason plus remediation.
- `selectInputBackend()` prefers ydotool on Wayland and xdotool on X11, then falls back.
- Every action calls `_ensure()`, so an unavailable backend throws a clear error instead of
  pretending to click.
- `move(x, y, durationMs)` now glides in steps instead of ignoring the duration: it reads the
  pointer with `xdotool getmouselocation` and interpolates. With no X display (where the start is
  unknown) it makes the one jump the backend supports, rather than claiming a smooth move.
- `createInputSimulator()` remains the synchronous ydotool constructor for compatibility;
  `getInputSimulator()` returns the selected backend.

On this host `probe()` reports `ydotool is not installed` with remediation, and
`detectCapabilities()` reports `input: "none", inputReady: false` — the truth, not `ydotool`.

## 3. Capture is a real picture

- [dbus-integration.mjs](../showcase/tauri/sidecar/computer-control/dbus-integration.mjs) now calls
  the portal with its **real** two-argument `Screenshot(parent_window, options)` signature (it used
  to pass an app id as a third argument), builds the request proxy from supplied introspection XML
  (the request object does not exist until the call, so introspecting it would fail) and subscribes
  to `Response` before asking, passes `interactive`/`modal`, and resolves the returned file URI to
  bytes (`buffer`, `dataUrl`). The request path uses the caller's real unique name, not `:1.0`.
- `linux_capture_screen` uses the desktop's screenshot path (`captureViaPortal` → the shell's
  X11 root-window grab or the Wayland portal) and returns the image to the model as content,
  instead of a URI with no pixels.
- `linux_ocr` captures the same way and runs OCR on the resulting file, then deletes the temporary
  capture.

## 4. OCR is real (or says why not)

- `screen.mjs` `ocrImage()` uses the native `tesseract` binary when present; when it is absent it
  falls back to `tesseract.js`, and returns the engine's actual error if the language data cannot
  be fetched.
- `ocr-adapter.mjs` no longer claims success: `recognizeImage` returns `{ok, text, error, engine}`.
- The stub text `"OCR requested via portal…"` is gone, and a test asserts its absence.
- `detectCapabilities()` reports `ocr` only when the binary probe succeeds, naming
  `tesseract`/`tesseract.js` and giving the reason otherwise.
- `detectCapabilities()` also probes the screenshot portal for real (`portalInfo()` reads
  `org.freedesktop.portal.Screenshot`'s `version` property): this desktop reports
  `portal: "screenshot-v2"`, and a desktop without the portal reports `none` with the reason.

## 5. Verification is real

[verification.mjs](../showcase/tauri/sidecar/computer-control/verification.mjs) implements
`file_exists`, `file_contains`, `window_focused`, `window_title`, `element_present`, `text_present`
(accessibility first, OCR second), `clipboard_equals`, `image_changed`, `command_succeeds`,
`url_matches` and `custom`. Every condition needs actual evidence; unknown types, a missing AT-SPI
bus, a missing capture source, or an unchecked command fail **closed**. `verifyAll()` aggregates
correctly. The `not_implemented` success path is deleted (a test asserts the string is gone).

## 6. Files

| File | Change |
|---|---|
| `computer-control/atspi-adapter.mjs` | rewritten |
| `computer-control/input-simulation.mjs` | rewritten (xdotool + honest ydotool probe) |
| `computer-control/verification.mjs` | rewritten (real conditions, fail closed) |
| `computer-control/dbus-integration.mjs` | fixed portal signature, early listener, bytes |
| `computer-control/ocr-adapter.mjs` | honest errors and engine reporting |
| `computer-control/index.mjs` | truthful `detectCapabilities()` |
| `screen.mjs` | tesseract.js fallback |
| `tools.mjs` | `linux_capture_screen` returns the picture; `linux_ocr` OCRs for real |
| `desktop/linux-backend.mjs` | mouse down/up and relative move use the selected backend |
| `test/atspi-adapter.test.mjs` | new fake-bus tests |
| `test/computer-control.test.mjs` | rewritten for probes, capabilities, verification, stub removal |

## 7. Tests executed

- `node test/atspi-adapter.test.mjs` — fake D-Bus tree: app list, windows, pid, roles, states,
  actions, values, attribute/state filters, `DoAction`, `GrabFocus`, caching.
- `node test/computer-control.test.mjs` — input probes, truthful capabilities, OCR failure, real
  verification (including fail-closed cases), and static checks that the old stubs are gone.
- `npm test` in `showcase/tauri/sidecar` — full suite, exit 0.
- `npm run build` — exit 0.
- Movement duration with a fake `xdotool` on `PATH`: `move(100,100,120)` writes at least 3
  `mousemove` calls and ends on the target; `move(10,10)` writes exactly one.
- Portal capture with a fake bus: request path (`1_42/<token>`), two-argument `Screenshot`, options
  variants, early `Response` subscription, and picture bytes returned.
- Verification `text_present`: `target` is searched as text and does **not** silently scope to an
  application named after it; only `app`/`applicationName` narrows the search.
- Live probe through the **real tool interface** (`createTools()`): `linux_list_apps` returned 3
  applications with pids and toolkit names (`mutter-x11-frames`, `gnome-software`, `amberol`), and
  `linux_list_windows` returned `amberol: Soolking - Seknet Marseille @ 0,0 600x660` with states.
  `linux_capture_screen` and `linux_ocr` correctly refused with "JARVIS V2 isn't running." when no
  shell was attached (no false success).
- Live read-only probe through the module: `detectCapabilities()` reports `atspi: true`,
  `dbus: true`, `input: "none"` with a reason, `ocr: true` (tesseract), `portal:
  "screenshot-v2"`; the AT-SPI driver lists 3 apps, a real amberol window with bounds
  (0,0 600x660), and its elements with normalized roles and Action names.

## 8. Known limitations

- `linux_capture_screen` / `linux_ocr` need the Tauri shell's `askShell`; in a bare sidecar they
  fail with "no shell in test" (correctly, not silently).
- Under Wayland, global input still needs `ydotoold` (or `xdotool` for XWayland windows); nothing
  can inject global input without one of those. The tool now says exactly that.
- `getFocusedApplication()` depends on the app reporting `STATE_ACTIVE`/`STATE_FOCUSED` on its
  window; some apps (observed: amberol) do not, so the off-limits-app guard cannot identify them.
  Typing into a terminal is still refused by `HANDS_OFF` where the app is known; this is a
  remaining safety gap for Batch 8.
- No real click or keystroke was sent in this batch (the host has no input backend), so the new
  xdotool code path and duration glide are type-checked and unit-tested but not exercised against a
  live pointer. OCR was not run on a real screenshot here; those paths are covered by unit tests
  and the capability probe.
- The portal client is unit-tested against a fake bus; the live portal answered the capability
  probe (`screenshot-v2`), but an actual portal capture needs the Tauri shell (not run here).
