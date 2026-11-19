# Respan + Exa.ai Integration — Completion Report

Date: 2026-11-19 · Branch: `main` · Sidecar package: `jarvis-v2-sidekick`

## 1. Summary

Respan is now the observability layer for JARVIS V2 and Exa is a first-class search/research provider. Both are
optional, independently configurable, and off by default for Respan. Neither is required for startup, a reply, or a
tool call. The Respan *browser bridge* (reading authenticated `platform.respan.ai` pages) is unchanged and lives
separately in the same Connections pane.

## 2. Files created

- `showcase/tauri/sidecar/respan.mjs` — Respan client, span model, privacy/scrubbing, gateway target helper.
- `showcase/tauri/sidecar/test/respan.test.mjs` — span shape, parenting, privacy, switches, sampling, lifecycle.
- `showcase/tauri/sidecar/test/respan-trace.test.mjs` — end-to-end wiring: one request → workflow/chat/tool/step tree, plus a failed call as an error span.
- `showcase/tauri/sidecar/test/services-live.mjs` — optional live check (`npm run test:services`), skips without keys.

## 3. Files modified

- `showcase/tauri/sidecar/exa.mjs` — search types validated, contents options (`summary`, `subpages`, `ids`, `maxAgeHours`, `livecrawlTimeout`), per-URL `statuses`/errors, 429/`Retry-After` backoff, `exaResearch` via `/agent/runs`.
- `showcase/tauri/sidecar/tools.mjs` — Exa tools registered (`exa_search`, `exa_get_contents`, `exa_find_similar`, `exa_research`, `exa_search_status`), permission-tagged.
- `showcase/tauri/sidecar/sidekick.mjs` — Respan boot/settings/key login/connection test, Exa key login/settings, request trace open/close, LLM turn and tool spans, agent-step spans, optional gateway routing, panel protocol handlers, status in `panel()`.
- `showcase/panel/panel.js` and `showcase/panel/index.html` — new `Connections` pane: Respan group, Respan browser bridge group, Exa group.
- `showcase/tauri/sidecar/package.json` (and lock) — `@respan/respan@2.5.0`, `@opentelemetry/api@1.9.0`; new test scripts.

## 4. Integration points

- Request lifecycle (`prompt()`): `startRequestTrace` on entry with `session.id`, turn, provider, model; `endRequestTrace` on success, abort and failure. `currentTrace` is cleared afterwards.
- LLM turns: stream `turn_end` → `recordLlmTurn` (model, provider, usage, latency, optional scrubbed prompt/reply).
- Tool calls: stream `tool_call_start`/`tool_call_end` → `recordToolCall` (name, duration, error, denial reason; args/results only with `captureToolPayloads`).
- Agent steps: agent-core executor events (`step_completed/failed/denied/cancelled`) → `recordAgentStep`.
- Tool spans and LLM spans are parented to the request span via OpenTelemetry context.
- Quit: `flushRespan` then `shutdownRespan` before `quit`.
- Gateway mode: `gatewayTarget({ provider })` returns a Respan base URL/key only when enabled and the provider is OpenAI or OpenRouter; OAuth/local providers are never routed.

## 5. APIs and SDKs used

- Respan: `@respan/respan` 2.5.0 (`Respan`, `getClient`, `getTracer`, `flush`, `shutdown`, `initialize`), with `@opentelemetry/api` for context/span parenting. Endpoint defaults to `https://api.respan.ai/api`; spans use `traceloop.span.kind`, `gen_ai.*`, `respan.sessions.session_identifier`, `respan.trace.trace_group_identifier`.
- Exa: `https://api.exa.ai` (`/search`, `/contents`, `/findSimilar`, `/agent/runs`, `/agent/runs/{id}`) with `x-api-key`.
- Secrets: existing per-OS secure store (`respan-key`, `exa-api-key`).

## 6. New / changed agent tools

- `exa_search` — semantic/filtered web search with snippets, metadata, citations.
- `exa_get_contents` — page content, highlights, optional summary, multiple URLs/ids, subpages, freshness, per-URL status.
- `exa_find_similar` — similar pages.
- `exa_research` — multi-source research run; returns `answer` (generated) separately from `sources` (retrieved), plus optional structured output and cost. Requires approval (paid).
- `exa_search_status` — configuration status, no key echoed.

Respan has no agent-facing tool; it is observability. Its status is exposed in `panel()` and the Connections pane.

## 7. New settings

Connections pane:

- Respan: enable/disable, API key (write-only, masked), environment (development/production), gateway mode, trace LLM requests, trace tool calls, trace agent steps, include prompts/replies, include tool arguments/results, connection test, status line. Respan browser bridge URL moved here as a separate, clearly labelled section.
- Exa: enable/disable, API key (write-only, masked), status/source line, connection test.

Config keys: `respanEnabled`, `respanEnv`, `respanKeySaved`, `respanTraceLlm`, `respanTraceTools`, `respanTraceSteps`, `respanCapturePayloads`, `respanCaptureToolPayloads`, `respanGateway`, `exaEnabled`, `exaKeySaved`. Keys live in the secure store, never in config or logs.

## 8. Security

- Credentials are saved only after a successful live check; a typo never replaces a working key.
- Keys are never returned in status, logs, tool results, spans, or panel state; fields are cleared after save.
- Telemetry is metadata-only by default; prompt/reply capture is opt-in and scrubbed (secrets and e-mail addresses removed, length capped); tool args/results stay local unless separately enabled and are redacted first.
- Respan cannot fail or block a request: every recorder call is wrapped and swallows errors; telemetry off opens no trace and Exa still works.
- Exa keys are stripped from errors and status; requests time out and retry 429/5xx with `Retry-After`.
- Exa research requires approval because it spends money; the tool is observe-level but approval-gated.
- Gateway routing is limited to OpenAI/OpenRouter and never touches OAuth or local providers.

## 9. Tests executed

- `npm test` (full sidecar suite, pipefail): **passed**, exit 0. Includes `exa.test.mjs`, `respan.test.mjs`, `respan-trace.test.mjs`.
- `node test/respan.test.mjs` and `node test/respan-trace.test.mjs`: passed.
- `node test/exa.test.mjs`: passed.
- `node test/services-live.mjs` (no keys): passed, exit 0, reports skips.
- `npm run build`: passed, exit 0 (note: `bundle.sh` skips `usocket` when unavailable).
- `node --check showcase/panel/panel.js`: passed.

No live vendor calls were made; no API keys were available in this environment, so Respan ingest and Exa search/research were exercised with mocks only.

## 10. Known limitations

- Respan uses the vendor SDK rather than the raw OTLP/HTTP path sketched in the Phase 0 audit; the SDK provides the exporter, batch queue and flush. The audit's `respan_status` agent tool was not added — status is available in the panel and in `panel()`.
- LLM spans are per turn (per `turn_end`), not per individual model call, because the agent library does not expose per-call hooks.
- Cost is reported only where the provider returns it; nothing is estimated.
- Exa `/agent/runs` is usage-priced and long-running; runs are capped at the configured duration (default 3 minutes) and polled with backoff. `/research/v1` is not used.
- Exa search types no longer include `keyword`; the tool rejects unknown types instead of sending them.
- The Respan browser bridge and Respan observability are separate features sharing a vendor name; they are labelled separately in the pane.

## 11. Manual configuration required

- Respan: save an API key on the Connections page (or set `RESPAN_API_KEY`), enable tracing, choose environment and signals. Optional: enable gateway mode for OpenAI/OpenRouter routing.
- Exa: save an API key on the Connections page (or set `EXA_API_KEY`); Exa is enabled by default and reports `not_configured` without a key.
- Optional live verification: `RESPAN_API_KEY=... EXA_API_KEY=... npm run test:services` (add `--research` to run a paid Exa research run).
- No local model or extra RAM is required.