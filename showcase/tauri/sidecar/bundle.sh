#!/bin/bash
# Bundles the sidekick brain into dist/ so the app ships one JS file instead of node_modules.
# Optional voice deps stay external (never loaded).
set -euo pipefail
cd "$(dirname "$0")"
# esbuild: $ESBUILD, then PATH, then the one `npm ci` installs here (a devDependency).
ES="${ESBUILD:-}"
if [ -z "$ES" ]; then
  ES="$(command -v esbuild || true)"
  [ -n "$ES" ] || { [ -x node_modules/.bin/esbuild ] && ES=node_modules/.bin/esbuild; } || true
fi
[ -x "$ES" ] || { echo "esbuild not found; set ESBUILD=/path/to/esbuild" >&2; exit 1; }
rm -rf dist && mkdir -p dist/node_modules
# web_fetch (GG Coder's) loads its page and PDF readers by dynamic import, which a bundler can't follow: they stay
# external and are copied below. linkedom is also bundled, because web_search imports it directly.
# Native/optional deps used by computer-control and dbus-next/tesseract are external to avoid bundling issues.
WEB_EXT=(--external:@mozilla/readability --external:turndown --external:turndown-plugin-gfm --external:unpdf \
  --external:x11 --external:usocket --external:abstract-socket --external:dbus-next \
  --external:tesseract.js --external:better-sqlite3 --external:pino --external:tesseract.js-core)
"$ES" sidekick.mjs --bundle --platform=node --format=esm --target=node22 --outfile=dist/sidekick.mjs \
  --external:@huggingface/transformers --external:ogg-opus-decoder "${WEB_EXT[@]}" \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --log-level=warning
# Each background agent runs in its own process (agents.mjs forks it from the same folder).
"$ES" agentrun.mjs --bundle --platform=node --format=esm --target=node22 --outfile=dist/agentrun.mjs \
  --external:@huggingface/transformers --external:ogg-opus-decoder "${WEB_EXT[@]}" \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --log-level=warning
# The readers and their dependencies, laid out as npm installed them (a nested copy travels with its parent).
# One that's missing only costs web_fetch its Markdown: it falls back to plain text.
# External runtime deps (kept external above) must also be copied when present so the bundled sidecar can import them.
node - linkedom @mozilla/readability turndown turndown-plugin-gfm unpdf dbus-next tesseract.js tesseract.js-core better-sqlite3 pino <<'EOF'
const fs = require('node:fs'), path = require('node:path');
const done = new Set();
function copy(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const src = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(src, 'package.json'))) {
      if (dir !== process.cwd() || done.has(name)) return; // nested ones travel with their parent
      done.add(name);
      fs.cpSync(src, path.join('dist/node_modules', name), { recursive: true, dereference: true });
      const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) copy(dep, src);
      return;
    }
    if (dir === process.cwd()) return console.error(`bundle: ${name} isn't installed; skipping`);
  }
}
for (const name of process.argv.slice(2)) copy(name, process.cwd());
EOF
# Keep only the host's better-sqlite3 prebuild so AppImage/linuxdeploy doesn't try to resolve
# deps for other platforms/ABIs (e.g. musl prebuilds lack libc.musl on glibc hosts).
if [ -d dist/node_modules/better-sqlite3/prebuilds ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64|Linux-amd64) keep="linux-x64.node" ;;
    Linux-aarch64|Linux-arm64) keep="linux-arm64.node" ;;
    *) keep="" ;;
  esac
  if [ -n "$keep" ]; then
    for f in dist/node_modules/better-sqlite3/prebuilds/*; do
      [ "$(basename "$f")" = "$keep" ] || rm -f "$f"
    done
  fi
fi
# The recorded beats (beats/make.mjs): the audio and its index, not the script.
mkdir -p dist/beats && cp beats/index.json beats/*.pcm dist/beats/
echo '{"type":"module"}' > dist/package.json
