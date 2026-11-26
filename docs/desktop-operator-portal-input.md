# Linux input through the desktop portal (libei)

Date: 2026-11-26 · Follows [desktop-operator-batch3.md](desktop-operator-batch3.md) · Status: **working on this host**

Goal: give V2.1 the input path its own Wayland table promises — one desktop consent instead of
`ydotoold` plus a `uinput` udev rule — and give the agent a way to write a field that needs no
keyboard at all.

---

## 1. Why the old path was not enough

Batch 3 made the Linux backend honest, but on Wayland it could still only work with
`ydotoold` running against a writable `/dev/uinput`: a system setup (root, `input` group, udev
rule) before the agent could click anything. The spec (§5.1.3, §5.1.4) and the audit's Batch 3 plan
both name the modern answer — `org.freedesktop.portal.RemoteDesktop` + `ConnectToEIS` → libei — and
nothing implemented it.

## 2. The helper: `src-tauri/input-linux`

A small Rust crate (`roamies-input`, built by `build.sh` for Linux targets and bundled through
`binaries/roamies-input` in `tauri.linux.conf.json`; the shell passes its path as `ROAMIES_INPUT`).

| Layer | What it does |
|---|---|
| `main.rs` | `serve` (JSON lines on stdin/stdout, one reply per command), `probe` (what this desktop offers, no prompt), `clear-token` |
| `session.rs` | the portal session, the EIS connection, and the portal's own `Notify*` calls as the fallback |
| `logic.rs` | command parsing and validation (`logic.rs` builds on any OS, so `cargo test` runs it anywhere) |

The session, in order:

1. `$LIBEI_SOCKET` set (a compositor or a test host): connect straight to it, no portal.
2. `RemoteDesktop` → `CreateSession` → `SelectDevices(keyboard|pointer, persist: explicitly revoked)`
   with the saved restore token → `Start` (the consent dialog; the returned token is saved 0600 in the
   data directory) → `ConnectToEIS`.
3. No `ConnectToEIS` (portal 1) and not refused: the portal's `NotifyPointer*`/`NotifyKeyboardKeycode`/
   `NotifyPointerAxis` calls, which inject input without text.
4. The EIS client offers `ei_callback`, `ei_connection`, `ei_pingpong`, `ei_seat`, `ei_device`,
   `ei_pointer`, `ei_pointer_absolute`, `ei_button`, `ei_scroll`, `ei_keyboard` and `ei_text`; it
   emulates only what the desktop actually resumed, so a missing interface is a named error
   ("the desktop did not offer the keyboard for remote control"), never a silent no-op.
5. Absolute moves and drags are checked against the `Region`s the desktop reported, so a coordinate
   from an outdated screenshot is refused instead of clicking somewhere else.
6. Text goes out as `ei_text` UTF-8 in ≤256-byte chunks (by character, never splitting a codepoint).
   Typed keys use evdev codes; the portal's `Notify*` path adds the 8 the XKB keycode needs.

The portal session is held for as long as `serve` runs (one dialog per app run, and none at all once
the token is there), and ends when the process exits.

## 3. The sidecar half

- [libei-backend.mjs](../showcase/tauri/sidecar/computer-control/libei-backend.mjs) — the helper's Node
  client: finds the binary (`ROAMIES_INPUT`, next to the app, the build tree, `PATH`), probes without
  a prompt, keeps one session open, maps actions to commands, and turns a denial into the reason plus
  the fix. Where the desktop has no `ei_text` it types through `ydotool` when that daemon answers, and
  otherwise says which of the two ways to use instead.
- [input-simulation.mjs](../showcase/tauri/sidecar/computer-control/input-simulation.mjs) —
  `backendOrder()` makes the choice a pure, tested function: Wayland → portal, `ydotool`, `xdotool`;
  X11 → `xdotool`, portal, `ydotool`.
- [atspi-adapter.mjs](../showcase/tauri/sidecar/computer-control/atspi-adapter.mjs) — new
  `setText()`: `org.a11y.atspi.EditableText.SetTextContents`, falling back to `Text.DeleteText` +
  `InsertText`, for fields that accept text through accessibility.
- [tools.mjs](../showcase/tauri/sidecar/tools.mjs) — new `linux_set_text` (trusted, no keystrokes;
  same `checkLinuxInputTarget` guard as typing), and `linux_type_text`'s description now names the
  portal path.
- [computer-control/index.mjs](../showcase/tauri/sidecar/computer-control/index.mjs) — the doctor
  checks the helper and the portal (`RemoteDesktop`, portal version) next to the `ydotool` checks.
- [sidekick.mjs](../showcase/tauri/sidecar/sidekick.mjs) — the prompt tells the model about the
  permission prompt and `linux_set_text` instead of implying typing always works.
- `.github/workflows/ci.yml` — the helper's tests run on every OS; `build.sh` builds it in release on
  Linux; `.gitignore` ignores its `target/`.

## 4. Live results on this host (GNOME, Wayland, `xdg-desktop-portal-gnome`)

```
$ roamies-input probe
{"ok":true,"backend":"libei","portalVersion":2,"eis":true,"text":null,
 "deviceTypes":"keyboard,pointer,touchscreen","socket":false,"token":true}

$ roamies-input serve        # one ping, then stop
{"event":"ready","backend":"libei","pointer":true,"keyboard":true,"text":false}
{"id":1,"ok":true}
{"id":2,"ok":true}
```

Through the sidecar's own client (`LibeiBackend`): `probe()` returned backend `libei`, portal v2;
`move(180, 180)` moved the real pointer over the real desktop; `type("x")` — with `ei_text` absent
on this Mutter — fell back to `ydotool` and typed it. `roamies-input clear-token` and the token
file were exercised too (the probe reports `token`).

`probe` reports `text: null` on purpose: the portal version says the desktop has `ConnectToEIS`, not
that its compositor implements `ei_text`, and claiming otherwise is how a session ends up refusing
every keystroke it promised.

## 5. Tests executed

- `cargo test` in `src-tauri/input-linux` — 5 tests: every command the sidecar sends is parsed, bad
  commands are refused before the desktop sees them, buttons keep evdev numbers, points must lie on a
  reported region, text splits on characters under the limit.
- `node test/libei-backend.test.mjs` — a fake helper: probe flags, one line per action, evdev codes for
  keys and combos, text as text, unknown keys refused locally, a desktop without text known from the
  ready line, a refused consent carrying its reason and fix, a missing helper explaining what to build.
- `node test/computer-control.test.mjs` — the backend order matrix (Wayland/X11, with and without a
  portal, a daemon or XWayland) and `backendOrder({wayland:true}) === []`.
- `npm test` in `showcase/tauri/sidecar` — full suite, exit 0.
- The live probes and the pointer move above, through the real helper and the real client.

## 6. Known limitations

- Typing (`ei_text`) depends on the compositor; this GNOME does not expose it, so typing here is
  `ydotool` (or `linux_set_text`). Keystrokes, clicks, drags, scrolls and pointer motion are the
  portal's own.
- The helper is built only for Linux targets; `build.sh` skips it elsewhere, and the sidecar reports
  "the input helper is not installed" with the command to build it.
- A Wayland session's consent dialog is per app identity: a rebuild with a different name asks again
  (the token is still honoured where the portal accepts it).
- Flatpak/Snap packaging of the shell would need the portal permission declared in the manifest;
  that is packaging work, not code.
