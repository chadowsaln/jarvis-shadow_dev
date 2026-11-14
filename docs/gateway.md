# The Respan Gateway for the side calls

The two side calls beside the conversation — folding old turns into a summary, and the memory pass that learns
lasting facts — are one short question each, with a JSON answer. They can go through a local
[Respan Gateway](https://github.com/respanai/respan-gateway?utm_source=freebuff&utm_medium=paid&utm_campaign=respan-gateway&bfcid=bfc_1.eyJpZCI6ImI1MmIyZmNmLWJhNGYtNDA2OS04Y2FkLTdmYmJhOWZjZDU0NCIsImMiOiIyMDM2ODZkZS1mMzg0LTQ4NTQtYmViNC1hYzBiYWRmNmM1NTUiLCJrIjoiM2IxMGE4YmUtNzgyOS00MmJhLWFmNmEtYmI0YWUxZTRhY2Y4IiwiaWF0IjoxNzk0Njg4MjAyfQ.xotaQ-rE2_rAPmvK6AuSvZTFTaeX185UaicmYv8qWa4)
instead of the app's own sign-in: the gateway speaks OpenAI's chat format (`/v1/chat/completions`), routes each
model name to whichever provider its config or environment gives it, and can fall back from one account to the
next. That is useful exactly here: a fold or a memory pass that runs out of credit on the summary model moves to
the other provider instead of failing.

Everything below is optional and local. No Respan account, hosted credits, tracing export or deployment is used or
needed: the gateway runs on this computer, with the developer's own provider keys.

## Install

The gateway is a Python package (3.10+, wheels only) in a project environment of its own, `sidecar/gateway/`:

```bash
cd showcase/tauri/sidecar
python3 -m venv gateway/.venv
gateway/.venv/bin/pip install --only-binary=:all: -r gateway/requirements.txt   # respan-gateway==0.3.0
```

`gateway/requirements.txt` is the manifest. On Windows the interpreter is `gateway/.venv/Scripts/python.exe`.

## Configure

A config file is optional. With none, the gateway becomes the provider keys in the environment it starts with
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, …), and models route by name — the same summary model
these calls already ask for (`claude-haiku-5-5`, `claude-sonnet-5-5`, …) goes to the provider that serves it.

To name a route instead (`roamies-side`) and let it fall back between accounts:

```bash
cp gateway/gateway.example.toml gateway/gateway.toml    # ignored by git
$EDITOR gateway/gateway.toml                            # keep the providers whose keys you have
```

Keys stay references (`key = "env:ANTHROPIC_API_KEY"`) or in the environment — never literal keys in this file,
in source, or anywhere the browser can read. A `key = "env:NAME"` whose variable is unset stops the gateway with a
message naming it, so remove that provider if you don't have it.

## Run

```bash
cd showcase/tauri/sidecar
npm run gateway      # gateway/.venv/bin/python gateway/serve.py --port 8788
```

It listens on loopback only (`http://127.0.0.1:8788`) and prints that address once. Ctrl-C stops it; run the same
command to start it again. Without `npm` in the picture:

```bash
gateway/.venv/bin/python gateway/serve.py --port 8788 --config gateway/gateway.toml
```

`--port 0` takes any free port and prints it, which is what the smoke test does.

## Switch the side calls over

The gateway is off until the sidecar is started with it, so a normal run is unchanged:

| Variable | Meaning |
|---|---|
| `ROAMIES_GATEWAY=1` | Use the gateway at `http://127.0.0.1:8788` (the port `npm run gateway` serves on) |
| `ROAMIES_GATEWAY_URL=http://127.0.0.1:<port>` | Use a gateway at that address instead |
| `ROAMIES_GATEWAY_MODEL=roamies-side` | Ask for this route (or model) instead of the calls' own summary model |
| `ROAMIES_GATEWAY_KEY=…` | The client key, when the gateway's config sets `client_keys` (never a provider key) |
| `ROAMIES_GATEWAY_TIMEOUT_MS=120000` | How long a turn may take |

```bash
cd showcase/tauri
ROAMIES_GATEWAY=1 ./build.sh dev      # the app and its sidecar, folding and remembering through the gateway
```

Only `brain.mjs`'s `oneShot` — the fold and the memory pass — takes this path (`gateway.mjs`); the chat itself,
agents, voice and tools keep their own sign-in. If the gateway is down, has no key for the model, or answers with
an error, the side call logs one line and answers through the app's own sign-in as before, so nothing is lost by
leaving `ROAMIES_GATEWAY` set.

## What was checked

```bash
cd showcase/tauri/sidecar
node test/gateway.test.mjs     # in `npm test`: the route from the environment, and a turn against a fake gateway
npm run test:gateway           # the real gateway, end to end (needs gateway/.venv)
```

Observed on 2026-11-14 with `respan-gateway 0.3.0` (Linux x64, Python 3.14, wheel `cp310-abi3`):

- `node test/gateway.test.mjs` → `gateway tests: passed` — including a gateway that is down falling back to the
  own sign-in, and `400`/empty/not-JSON/timeout/unreachable answers each raising their named error.
- `npm run test:gateway` →
  `gateway smoke: passed — http://127.0.0.1:<port> routed roamies-side → fixture/fixture-model, answer: {"summary":"The user asked for a summary.","facts":[]}`
  (the port is a fresh free one each run). The provider there is a local fixture on loopback, configured as an
  `openai-chat` provider; `oneShot` sent the fold's system and user messages, the gateway routed the route to it,
  and its answer came back through the gateway. The test stops the gateway it started (SIGTERM, exit 0).
- `npm test` and `npm run build` (the esbuild bundle of `sidekick.mjs`, which now imports `gateway.mjs`) pass.
- A real provider request was **not** verified: this environment has no provider keys, and a fixture stands in for
  the provider. On your machine, start the gateway with your key and `ROAMIES_GATEWAY=1` as above; add
  `log = "text"` to `gateway/gateway.toml` to see each fold and memory pass in the gateway's request log.

The normal app run is unchanged: `./build.sh dev` in `showcase/tauri` (or `npm test` in `sidecar` for the tests).

Guides: the [gateway project](https://github.com/respanai/respan-gateway/tree/v0.3.0) and its
[Python README](https://github.com/respanai/respan-gateway/blob/v0.3.0/python/README.md).
