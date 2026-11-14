"""Serve the Respan Gateway on loopback for the sidecar's side calls.

`gateway.mjs` talks OpenAI's chat format to `<url>/v1`; the gateway routes each request to the
provider its config or environment gives it, so a fold or a memory pass can move between accounts
without the app knowing. Started by hand (`npm run gateway`), never by the app itself.

    python3 -m venv gateway/.venv
    gateway/.venv/bin/pip install --only-binary=:all: -r gateway/requirements.txt
    gateway/.venv/bin/python gateway/serve.py                 # a free port, printed once
    gateway/.venv/bin/python gateway/serve.py --port 8788     # what `ROAMIES_GATEWAY=1` expects

Reads `gateway/gateway.toml` when there is one, else the provider keys in the environment
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, ...) exactly as `respan-gateway` does.
The address goes to stdout on its own line as soon as it is listening, so a parent process can read
it; anything else the gateway says goes to stderr.
"""

import argparse
import signal
import sys
import threading
from pathlib import Path

import respan_gateway as rg

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / "gateway.toml"


def main() -> int:
    ap = argparse.ArgumentParser(description="Serve the Respan Gateway on loopback for Roamies.")
    ap.add_argument("--port", type=int, default=0, help="port to listen on (0: any free one), loopback only")
    ap.add_argument("--config", help=f"a gateway.toml to read (default: {DEFAULT_CONFIG} when it exists)")
    args = ap.parse_args()

    config = args.config or (str(DEFAULT_CONFIG) if DEFAULT_CONFIG.is_file() else None)
    try:
        gateway = rg.Gateway.from_file(config) if config else rg.Gateway()
    except rg.ConfigError as e:
        print(f"gateway: {e}", file=sys.stderr)
        print(f"gateway: copy {HERE / 'gateway.example.toml'} to {DEFAULT_CONFIG} and keep the providers you have,", file=sys.stderr)
        print("gateway: or set a provider key such as OPENAI_API_KEY in the environment", file=sys.stderr)
        return 2

    stop = threading.Event()

    def end(signum, frame):  # SIGINT/SIGTERM: leave the `with` block and stop the server
        stop.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, end)
        except (OSError, ValueError):  # not every platform takes both
            pass

    with gateway.serve(port=args.port) as server:
        print(server.url, flush=True)  # the one machine-readable line: http://127.0.0.1:<port>
        try:
            stop.wait()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
