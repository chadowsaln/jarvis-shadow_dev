# Respan + Exa.ai — Phase 0 Architecture Audit

Date: 2026-11-19 · No source files modified · Baseline: `npm test` green (68 files)

Read with: [desktop-operator-audit.md](desktop-operator-audit.md) (the same architecture, mapped for desktop control).

---

## 1. Method

Read in full or in the relevant windows: `sidecar/agentcore/*`, `sidecar/tools.mjs` (tool registry and the
`exa_*` / `browser_respan_*` tools), `sidecar/exa.mjs`, `sidecar/browser.mjs`, `sidecar/secrets.mjs`,
`sidecar/providers.mjs`, `sidecar/sidekick.mjs` (config, key login, request lifecycle, usage, tool events,
panel protocol), `showcase/panel/panel.js` + `panel/index.html` (settings panes, nav, message protocol),
`test/exa.test.mjs`, `test/browser*.test.mjs`, `test/claudecode.test.mjs`, `test/secrets.test.mjs`.

Researched the current vendor APIs (official docs only, URLs cited in §7): Respan OTLP ingest, span attributes,
gateway, evals, privacy flags; Exa search/contents/answer/agent endpoints, auth, rate limits.

**Headline:** Exa is already integrated. Respan is already integrated *as something else*. Both need work, but
neither needs a new subsystem.

---

## 2. What already exists (do not rebuild)

### 2.1 Exa.ai — a working, tested provider

`sidecar/exa.mjs` (168 lines): `exaStatus`, `exaSearch` (`POST /search`), `exaGetContents` (`POST /contents`),
`exaFindSimilar` (`POST /findSimilar`), over `https://api.exa.ai` with `x-api-key`, per-request timeout +
abort signal, key redaction in errors, injectable `fetchImpl` for tests. Key from `EXA_API_KEY` **env only**.

Tools (already registered, already permission-tagged, already in the agent's list):
`exa_search_status`, `exa_search`, `exa_get_contents`, `exa_find_similar` — all `observe`, no approval.
Also in the background agents' `WORK_TOOLS` (`agents.mjs:18`).
Tests: `test/exa.test.mjs` (status/missing key/no-fetch, result normalisation, contents, similar, error/timeout,
activity, tool wiring) — runs in `npm test` and as `npm run test:exa`.

### 2.2 Respan — present, but as a *browser bridge*, not observability

`browser.mjs:106-239`: `ROAMIES_RESPAN_BROWSER_BRIDGE` (default `http://127.0.0.1:18791`), `respanBridgeStatus`
(`/status`), `readRespanAuthenticatedPage` (`/read`) — reading **authenticated platform.respan.ai pages** through a
local browser extension, with no cookie/token access. Tools `browser_respan_bridge_status` and
`browser_read_respan_authenticated` (observe; the latter requires approval); `agentcore/preflight.mjs` hard-limits
the URL to `https://platform.respan.ai`; setting `respanBridgeUrl` exists in the panel (Voice page, `panel.js:984`)
with the `panel_respanbridge` message and in the `DEFAULTS` (`sidekick.mjs:151`).

That is a **different product surface** from Respan's tracing/gateway. It must keep working unchanged; the new work
is a separate module that shares only the vendor name. The two are independently configurable.

### 2.3 Telemetry today — local only

| Mechanism | Where | What it holds |
|---|---|---|
| `usage.jsonl` | `sidekick.mjs:1210` `logUsage` | one line per request: tokens, timings, model — never text; pruned to 90 days |
| `logLine` diagnostics | `sidekick.mjs`, `diagnostics.mjs` | request/tool/problem events, args redacted via `safety.redactArgs` |
| Activity lines | `activity.mjs` | what is happening, in words, for the panel |
| Agent core log | `agentcore/executor.mjs` | `step_started/completed/failed/denied`, `approval_*`, with plan/step/approval ids |

No spans, no trace ids, no external export, no evals.

### 2.4 MCP

`claudecode.mjs` serves **our** tools to Claude Code as an in-process MCP server (`mcp__gg__*`), stripping the
prefix before execution. There is no external MCP client and no MCP tool registry to hook. "Trace MCP operations"
therefore means: trace the same tool calls (they run through the same `execute`), which the tool-span work already
covers. No new MCP infrastructure.

### 2.5 Keys, config and settings

- `secrets.mjs`: per-OS secure store (macOS login Keychain via the signed helper, Windows DPAPI, Linux Secret
  Service via `secret-tool`), stdin/stdout only, name pattern `[a-z0-9-]{1,40}`, test-file fallback only under
  `ROAMIES_DATA_DIR`. Used today for the voice providers (`voiceKeyLogin`: validate → live check → save → flag).
- Provider keys/OAuth: `@kenkaiiii/gg-core` storage (`apiKeyLogin`, `refreshAuth`, `credsFor`), never in `config`.
- `config`: `DEFAULTS` at `sidekick.mjs:127-157`, read from `CONFIG_PATH`, written by `saveConfig()` (backup on write).
- Settings UI: `PANES` in `panel.js:1084` drives `TABS`; nav buttons in `panel/index.html:35-55`; each control sends
  a `panel_*` message that `sidekick.mjs` handles, writes config, and re-renders. A new pane is: nav button +
  `<section class="pane" id="pane-x">` + a builder in `PANES` + one message handler.

### 2.6 Instrumentation points (exact)

| Signal | Hook | Fields available |
|---|---|---|
| Request start/end | `prompt()` (`sidekick.mjs:1280-1430`) | `turn` (=`requestNo`), `session?.id`, `config.provider`, `config.model`, abort/stall, `lastFailed` |
| Per-turn usage | stream event with `e.usage` (`sidekick.mjs:1384-1388`) | `inputTokens`, `cacheRead`, `cacheWrite`, `outputTokens` |
| Tool call start/end | stream `tool` / `tool_call_end` (`sidekick.mjs:1402-1410`) | `toolCallId`, `name`, redacted args, `durationMs`, `isError` |
| Authorized call result | agent core `logger` (`sidekick.mjs:664-682` → `executor.mjs`) | `step_started/completed/failed/denied`, plan/step ids, approval id, reason |
| Conversation | `session.id` | stable across turns |
| Provider creds | `credsFor()` / `makeAgent()` | resolution already centralised |

`use.calls` exists but `e.usage` arrives per turn, so an LLM span is per turn, not per model call. That is honest
and enough for latency/tokens/cost; per-call spans would need changes inside `@kenkaiiii/gg-agent`.

---

## 3. Gap analysis against the request

### Respan (Phase 1)

| Requirement | State | Work |
|---|---|---|
| Trace LLM requests (model, provider, latency, tokens, errors) | Absent | request/workflow span + per-turn chat span |
| Trace agent steps | Partial (local executor log) | map executor events to `agent` spans |
| Trace tool calls | Partial (local log) | tool spans from stream events; denials from executor |
| Conversation id / execution id | Absent | `respan.sessions.session_identifier` = `session.id`; trace group = `turn` |
| Cost information | Absent | `gen_ai.usage.*` (cost only if the provider reports it; never invented) |
| Eval support | Absent | client method + explicit constraints (needs an evaluator id; no auto-eval) |
| Async, non-blocking, never required | Absent | bounded queue + batcher, failures local only |
| Optional gateway routing | Absent | config toggle, OpenAI-compatible providers only |
| Privacy: no keys/PII, redaction, disable | Absent | metadata-only default, redaction pass, kill switch |
| Settings section + connection test + status | Absent (only the browser-bridge URL) | new Connections pane (see §5) |

### Exa (Phase 2)

| Requirement | State | Work |
|---|---|---|
| Semantic search, count, domains, dates, snippets, URLs, metadata | Present | raise result cap, validate `type`, keep filters |
| Keyword search | **Doc drift**: no `keyword` type exists today; our tool advertises it | restrict to documented types (`auto|lite|deep-lite|deep|fast|instant|deep-reasoning`) |
| Full content, highlights, summary, multiple URLs, JS/PDF | Partial | add `summary`, `subpages`, `ids`, `maxAgeHours`, surface per-URL `statuses` and errors |
| Exa Research (multi-source, structured, attributed) | Absent | new `exa_research` on `POST /agent/runs` + `GET /agent/runs/{id}` (`/research/v1` is deprecated) |
| Distinguish retrieved facts from generated conclusions | Absent | return `sources` (grounding) separately from `answer`, labelled |
| Autonomous use by the agent | Present (tools registered) | prompt guidance for when to research, and when not to |
| Preserve Browser Intelligence | Present | nothing removed; Exa stays complementary |
| API key in secure storage, settings, never in UI/logs | Absent (env only) | `secrets` entry `exa-api-key` + config flag + pane field |
| Timeouts, retries, rate limits, provider errors | Partial | 429/`Retry-After` backoff, 401/402/403 messages, per-URL errors |

### Phase 3-6
Interaction between the two (a research run produces spans), security, tests, and the completion report are planned
in §4-§6 and will be reported per phase.

---

## 4. Design

### 4.1 `sidecar/respan.mjs` — client and span model

Raw **OTLP/HTTP JSON** to `https://api.respan.ai/api/v2/traces` with `Authorization: Bearer <key>`.
No new dependency: the project pins exact versions, and the TypeScript SDK's current version is not verifiable from
the docs (the SDK is optional; OTLP is officially supported).

```
createRespan({
  enabled, apiKey, environment: 'development'|'production', endpoint,
  capturePayloads = false,       // metadata only unless the person opts in
  serviceName = 'jarvis-v2', flushMs = 3000, maxBatch = 40, maxQueue = 500,
  fetchImpl = globalThis.fetch, now = Date.now, logger = null,
})
→ { startTrace({ sessionId, turn, provider, model }), endTrace(status),
    startSpan(trace, { name, kind, attrs }), endSpan(span, { status, attrs }),
    recordToolCall(trace, {...}), recordLlmTurn(trace, {...}), flush(), stop(), stats() }
```

Span attributes (per Respan docs): `traceloop.span.kind` = `workflow|agent|chat|tool`, `llm.request.type: chat`,
`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.prompt_tokens|completion_tokens`,
`respan.trace.trace_group_identifier`, `respan.sessions.session_identifier`; status `1`/`2` + `message`.
Trace id 32 hex, span id 16 hex, nanosecond timestamps, `parentSpanId` for the tree.

Behaviour rules: never awaited by the request path; batches on a timer; bounded queue dropping oldest with a
`dropped` counter; every failure is a local `logLine('respan_error', …)` and a counter, never a user-visible error;
`stop()` flushes with a 2 s cap; no key in any log, trace attribute, or UI state.

### 4.2 Wiring (only existing hooks)

- `prompt()`: on start, `startTrace` (session id, turn, provider, model); on the existing success/failure/abort
  paths, `endTrace`.
- Stream loop: `e.usage` → `recordLlmTurn`; `tool`/`tool_call_end` → `recordToolCall` (args redacted by
  `safety.redactArgs`; results never attached unless payload capture is on, and then capped).
- Agent core logger (already wired, `sidekick.mjs:664-682`): `step_denied`/`approval_denied` → error tool span;
  this gives denials and approval outcomes that the stream events cannot show.
- Nothing else changes: no new agent core, no parallel registry, no blocking awaits.

### 4.3 Optional gateway

`config.respanGateway` (default off). When on **and** the provider is one we can point at an OpenAI-compatible base
URL, requests go to `https://gateway.respan.ai`; OAuth providers are never touched. Spans carry
`respan.gateway: true` so traces stay honest. If Respan is unreachable the setting is inert: the provider's own
endpoint is used and the failure is logged locally.

### 4.4 Exa upgrades

- `exa.mjs`: accept `summary`, `subpages`, `maxAgeHours`, `ids`; return `statuses` and per-URL errors; validate
  `type` against the documented set; `numResults` clamp 1..100 (client) / 20 (tool); `Retry-After`-aware backoff on
  429 (max 2 retries); keep the injectable fetch.
- New `exaResearch({ query, effort, outputSchema })`: create run → poll with backoff (cap ~3 min, respects abort) →
  `{ ok, findings: output.text, structured: output.structured, sources: grounding (title/url), generated: true,
  costDollars }`. `generated: true` plus separate `sources` satisfies "distinguish retrieved facts from generated
  conclusions".
- Key resolution: saved secret (`exa-api-key`) → `EXA_API_KEY` env → not configured. `exaStatus` reports the source
  (`secret`/`env`) without the value.
- Tools: `exa_research` is `observe` + **requiresApproval: true** (an agent run costs up to ~$1); existing tools keep
  their levels.

### 4.5 Settings — one Connections pane

New nav entry `Connections` (`panel/index.html`) + `connectionsPage` in `PANES` (`panel.js`), holding two groups:

- **Respan**: on/off, API key (write-only, masked), environment, gateway mode, trace agent steps / tool calls / LLM
  requests (three switches), capture payloads (off by default), connection test + status line, and the existing
  browser-bridge URL moved here from the Voice page (bridge stays a separate, clearly labelled section).
- **Exa**: on/off, API key (write-only, masked), status/source line, connection test, and the result cap.

Messages: `panel_respan` / `panel_exa` / `panel_*_test` → handler writes config and secrets, re-renders, returns a
status line. Keys never travel back to the panel; fields are cleared after save.

### 4.6 Privacy

Metadata-only by default (no prompt, completion, tool args or results in spans). With payload capture on: values
pass `redactArgs`, secret-looking keys are masked, strings capped at 240 chars, arrays at 8 items, depth 3 — the
same policy the approval dialog already uses. Respan's `disable_log` is a **gateway-only** option and is not part of
the OTLP schema, so payload control is ours, in code. A hard kill switch (`respanEnabled=false`) and per-signal
switches mean telemetry can never be required for a request to work.

---

## 5. Implementation order (each step verifiable)

1. **Phase 1a** — `respan.mjs` + `test/respan.test.mjs` (envelope, ids, batching, overflow, disabled, 401/500,
   no-secret, payload off). No wiring yet.
2. **Phase 1b** — wire `prompt()`, stream events, executor denials; `test/respan-trace.test.mjs` drives a fake
   request and asserts a workflow → (chat, tool) tree with one failing tool span.
3. **Phase 1c** — Connections pane (Respan group), key in `secrets`, connection test (send one span, report status),
   config flags, `respan_status` tool (observe; no key echoed).
4. **Phase 1d** — optional gateway path behind its flag + test with a fake fetch (provider base URL changes only
   when enabled and only for OpenAI-compatible providers).
5. **Phase 2a** — `exa.mjs` upgrades (types, summary/subpages/ids/maxAgeHours, statuses, backoff) + extend
   `test/exa.test.mjs`.
6. **Phase 2b** — `exaResearch` + polling + `exa_research` tool (approval) + tests with a fake clock/fetch.
7. **Phase 2c** — Exa key in `secrets` + Exa group in the pane + `exaStatus` source reporting.
8. **Phase 3** — one integration test: research request → Exa search/contents (mocked) → tool spans in a trace.
9. **Phase 4/5** — privacy tests (secret never in a span), permission tests, rate-limit and failure paths.
10. **Phase 6** — completion report with real results.

Every step ends with: `npm test` (pipefail), the touched test file on its own, and `npm run build`.

---

## 6. Risks and limitations (known before coding)

- **Respan attribute names** are documented but versioned by the vendor; if ingest rejects a field, spans are dropped
  server-side while our local counter still shows "sent". Mitigation: one live test with a user key, and a
  `connection test` that reports the ingest response.
- **Per-call LLM spans are not available** without changing the agent library; spans are per turn.
- **Cost** is only reported where the provider returns it; we never estimate.
- **Exa `/agent/runs`** is usage-priced (roughly $0.012–$1 per run by effort) and long-running; hence approval per
  call and a hard time cap. `/research/v1` is deprecated and will not be used.
- **Exa search types** changed (`keyword` is no longer documented); our tool descriptions are stale and will be
  corrected rather than silently sending an unsupported type.
- **The Respan browser bridge and the Respan observability integration are different features** with the same
  vendor name; confusing them in the UI would be a bug, so the pane labels them separately.
- **No live vendor calls** will be made without a user-supplied key; all automated tests use mocks.

---

## 7. Sources (vendor docs read for this audit)

Respan: [overview](https://www.respan.ai/docs/documentation/overview),
[tracing quickstart](https://www.respan.ai/docs/documentation/features/tracing/quickstart),
[OpenTelemetry integration](https://www.respan.ai/docs/integrations/opentelemetry),
[OTLP ingest API](https://www.respan.ai/docs/apis/traces/ingest-traces-otlp),
[create span API](https://www.respan.ai/docs/apis/spans/create-span),
[gateway quickstart](https://www.respan.ai/docs/ai-gateway/quickstart),
[gateway chat completion](https://www.respan.ai/docs/apis/gateway/create-chat-completion),
[evaluator run](https://www.respan.ai/docs/apis/evaluators/run-evaluator),
[create score](https://www.respan.ai/docs/apis/scores/create-score),
[PII redaction](https://www.respan.ai/docs/ai-gateway/features/pii-redaction),
[ZDR](https://www.respan.ai/docs/ai-gateway/security/zero-data-retention).

Exa: [search](https://exa.ai/docs/reference/search), [contents](https://exa.ai/docs/reference/get-contents),
[answer](https://exa.ai/docs/reference/answer), [agent](https://exa.ai/docs/agent/quickstart),
[research overview (deprecated /research/v1)](https://exa.ai/docs/reference/research/overview),
[error codes](https://exa.ai/docs/admin/error-codes), [rate limits](https://exa.ai/docs/admin/billing#rate-limits),
[pricing](https://exa.ai/docs/admin/pricing).
