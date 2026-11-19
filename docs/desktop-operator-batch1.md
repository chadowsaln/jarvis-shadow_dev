# Batch 1 — Unify the execution path

Date: 2026-11-19 · Follows [desktop-operator-audit.md](desktop-operator-audit.md) (Batch 0) · Status: **complete, tests green**

Goal: one path. Every tool the model can call is a tool the router and executor authorize, and the safe path is
the default one.

---

## 1. What was inspected

- `sidecar/agentcore/*` — router, executor, permissions, runtime, approval channel, preflight, planner.
- `sidecar/tools.mjs` — every tool object, its `permission` metadata (or absence), and its own `confirm()` calls.
- `sidecar/agents.mjs` — the five background-agent tools and `holdAfterLaunch`.
- `sidecar/sidekick.mjs` — agent-core wiring, the tool list rebuild in the Respan-bridge setting, the Stop paths
  (`interruptQuietly`, menu `stop`), and the request start in `prompt()`.
- `panel/panel.js` + `panel/approval.js` — the approval dialog the channel talks to.
- The live tool list, built with the real `createTools()`, and the live sidecar boot (before and after).

## 2. What was implemented

1. **Every tool declares what it may do.** The 22 tools that carried no permission metadata (20 on a Linux build
   without the hands helper, where `read_window`/`act_in_app` don't exist) were classified:
   `take_screenshot` (observe, **asks every time**), `draw` (assist), `see_photo` (observe), `run_command`
   (trusted, asks), `open` (observe), `read_window` (observe), `act_in_app` (trusted), `plan_steps`, `show_list`,
   `web_search`, `web_fetch`, `about_littleboy` (observe), `pomodoro`, `morse_practice` (assist),
   `remember_commitment`, `update_commitment`, `forget_fact` (trusted, ask), plus the five background-agent tools
   (`send_agent`, `tell_agent`, `answer_agent` trusted+ask; `stop_agent` trusted; `agent_report` observe).
2. **The agent core is on by default** (`ROAMIES_AGENT_CORE` unset = on; `0`/`false`/`no`/`off` = the explicit
   escape hatch) and **the default grant is `trusted`**.
3. **One surface, verified live**: the sidecar boot line now reports
   `[agentcore] on: level trusted, tools … (0 without permission metadata left out)` — 64 tools offered, none
   dropped. The same check passes on the bundled `dist/sidekick.mjs`.
4. **Stop reaches the execution layer.** Both stop paths call `agentCore.stop(...)` (cancel the running tool, deny
   anything after it) and `agentCoreApprovals.denyAll(...)`; the next request calls `agentCore.reset(...)`, which
   reopens the executor without reopening any approval.
5. **No double prompts.** An action the executor already approved (fingerprint-bound) tells the tool so
   (`ctx.approved`), and only `write_file`, `run_command` and `launch_app` use it to skip their own second question.
   The risky-click prompt inside `act_in_app` is untouched: it is a different question and still asks.
6. **A rebuilt tool list can never be the unwrapped one.** The Respan-bridge setting rebuilds `tools` in place; it
   now re-arms the core with `armAgentCore()` instead of leaving raw tools in the chat.
7. **Linux parity.** `linux_click_element` / `linux_type_text` / `linux_press_key` move from `sensitive` (denied at
   the default grant, so unusable) to `trusted`, matching `act_in_app` on macOS/Windows; `linux_move_mouse` is
   `assist`. `linux_click_element` now asks before clicking an element whose name reads as delete/pay/send/sign-out.

## 3. Files created

- [docs/desktop-operator-batch1.md](desktop-operator-batch1.md) — this report.
- (Batch 0) [docs/desktop-operator-audit.md](desktop-operator-audit.md).

## 4. Files modified

| File | Change |
|---|---|
| `showcase/tauri/sidecar/agentcore/index.mjs` | `isAgentCoreEnabled` defaults to on; explicit falsy turns it off |
| `showcase/tauri/sidecar/agentcore/runtime.mjs` | default level `trusted`; `stop()` / `reset()`; tools receive `{ signal, approved }` |
| `showcase/tauri/sidecar/agentcore/executor.mjs` | `reset()` clears cancel/pause/revoke for a new run (never a used approval) |
| `showcase/tauri/sidecar/tools.mjs` | permission metadata on 16 tool entries (14 objects plus the web pair); levels aligned on the 4 Linux primitives; risky-label ask in `linux_click_element`; `ctx.approved` skip in three tools |
| `showcase/tauri/sidecar/agents.mjs` | permission metadata on the five agent tools |
| `showcase/tauri/sidecar/sidekick.mjs` | `armAgentCore()` (startup + after a tool-list rebuild), Stop wiring, per-request `reset`, `about_littleboy` metadata |
| `showcase/tauri/sidecar/test/agentapproval.test.mjs` | default-on; reviewed full set; approval reaches the tool; stop/reset; default grant denies sensitive |
| `showcase/tauri/sidecar/test/toolschema.test.mjs` | every tool declares a level and says whether it asks |
| `showcase/tauri/sidecar/test/agents.test.mjs` | every agent tool declares a level |
| `showcase/tauri/sidecar/test/agentcore.test.mjs`, `test/permissions.test.mjs` | updated the flag's default (behaviour change, not a weakened assertion) |
| `JARVIS_V2_SPEC.md` | status line and ADR-001 consequence now describe the implemented default |

`sidekick.mjs` already had unrelated uncommitted voice/STT changes before this batch; my edits are confined to the
agent-core wiring, the two Stop paths, `prompt()`'s request start, and the `about_littleboy` tool.

## 5. Architecture decisions

- **The default grant is `trusted`, not `observe`** (your choice). Reading, clicking, typing, files and app launches
  work; `sensitive` and `administrative` stay denied, and an approval cannot lift a level — so deleting and killing
  are impossible until the host raises the grant.
- **Screen egress asks every time** (your choice): `take_screenshot` is observe-level but `requiresApproval: true`,
  so the picture only leaves the machine after a panel approval for that exact capture.
- **Capability parity beats platform caution** for the Linux primitives: a tool that does the same thing as
  `act_in_app` carries the same level, otherwise the operator works on macOS and is dead on Linux.
- **Delegation, not duplication**: the tool-level confirmation stays (defence in depth); only the *question* is
  skipped, and only when the executor's approval was bound to those exact normalised arguments.
- **Re-arming is a function**, so a rebuilt list can never bypass the router.

## 6. Security implications

Now gated that wasn't before (with the flag off, `requiresApproval` was inert):

- `copy_file` / `move_file` / `rename_file` / `create_directory` used to run **silently** — they now ask in the panel.
- `take_screenshot` and the background-agent launch/steering/answering ask, every time.
- `run_command`, `write_file`, `launch_app` ask exactly once (executor), not twice.
- A stop now makes further calls in that run fail closed instead of running.
- An unknown `ROAMIES_AGENT_CORE_LEVEL` grants nothing (`levelError` says why).

Still allowed without a prompt at `trusted`, deliberately:

- `act_in_app` (macOS/Windows) and `linux_type_text` / `linux_press_key` / `linux_click_element` (Linux): typing
  and clicking inside apps. Risky-labelled clicks still ask, and `HANDS_OFF` still refuses terminal, Settings,
  Keychain and password managers. **This is the main residual risk of the `trusted` default** and is the reason
  Batch 8 exists.

## 7. Tests executed

- `npm test` in `showcase/tauri/sidecar` (68 files) — full suite, `set -o pipefail`.
- Each edited test file run on its own: `agentapproval`, `toolschema`, `agentcore`, `permissions`, `agents`, `apps`,
  `terminal`.
- `npm run build` (esbuild bundle to `dist/`).
- A real sidecar boot from both `sidekick.mjs` and `dist/sidekick.mjs` with `HOME` pointed at a temp dir and empty
  stdin, reading the `[agentcore]` banner.
- `node --check` on all six edited source files.

## 8. Actual test results

- `npm test`: **exit 0**, all files passed (tail: exa, lifecycle, theme, orb state, hybrid, hearing smoke — all
  passed). No assertion was weakened; the three assertions about the flag's default were inverted because the
  default itself changed.
- `npm run build`: **exit 0**; `dist/sidekick.mjs` contains the new wiring.
- Live boot: `[agentcore] on: level trusted, tools take_screenshot, draw, … (0 without permission metadata left out)`
  for both source and bundle.
- New assertions that passed: full reviewed set offered (exact list, platform-aware); `take_screenshot` asks;
  `run_command`/`write_file` ask; `open` does not; approved calls tell the tool `approved: true` with an abort
  signal and unapproved ones `false`; a call after Stop is refused (`Blocked: cancelled`) and a new run reopens;
  `sensitive` denied at the default grant; `banana` as a level yields no grant plus a clear `levelError`.

## 9. Known limitations

- Not exercised on a real desktop in this batch: no approval dialog was clicked in the running app, no screenshot
  taken, no click sent. The transport is covered by the panel's own module in tests; the UI path is unchanged code.
- `trusted` means typing and clicking do not prompt (see §6). If that is too loose, the fix is one env value
  (`ROAMIES_AGENT_CORE_LEVEL=assist`), not code.
- A drawing that types into a field still relies on the existing `allowActions` setting rather than a permission
  level (`draw` is `assist` because it is the assistant's main channel).
- The tool context still does not carry the model's `toolCallId` into tools; `ctx` is `{ signal, approved }`.
  Nothing regressed (`draw` never received it through this path), but Batch 8 should thread it.
- Linux desktop control itself is still broken (Batch 3): levels are now right, the adapter underneath is not.

## 10. Remaining work

Batch 2 next (your choice of order): a `sidecar/desktop/` adapter layer with the missing verbs — relative move,
right/middle click, double click, press-and-hold, drag, horizontal scroll, window
minimize/maximize/restore/move/resize, monitors, quit app, clipboard read — plus new tools for them, all at
permission levels that already work under `trusted`. Batch 3 then makes the Linux backends real.
