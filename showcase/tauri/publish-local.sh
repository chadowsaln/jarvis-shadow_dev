#!/bin/bash
# Builds and publishes a signed release directly from this machine to GitHub Releases & the updates feed.
# Usage: ./publish-local.sh
set -euo pipefail
cd "$(dirname "$0")"

# 1. Check for signing key (either via env or ~/.gg/tauri-signing.key / ~/.tauri/jarvis_v2.key)
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  if [ -f "$HOME/.gg/tauri-signing.key" ]; then
    export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.gg/tauri-signing.key")"
  elif [ -f "$HOME/.tauri/jarvis_v2.key" ]; then
    export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/jarvis_v2.key")"
  else
    echo "::error:: TAURI_SIGNING_PRIVATE_KEY is required to sign the update bundle."
    echo "Please set TAURI_SIGNING_PRIVATE_KEY or save it in ~/.gg/tauri-signing.key"
    exit 1
  fi
fi

if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ] && [ -f "$HOME/.gg/tauri-signing.pass" ]; then
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$HOME/.gg/tauri-signing.pass")"
fi

VER=$(node -p "require('./src-tauri/tauri.conf.json').version")
TAG="v$VER"
echo "=== Building JARVIS V2 $TAG locally ==="

# 2. Build local bundle
export TAURI_BUNDLES="appimage"
./build.sh release

# 3. Verify built artifacts
B="src-tauri/target/release/bundle/appimage"
files=($B/*.AppImage)
sigs=($B/*.AppImage.sig)
[ ${#files[@]} -gt 0 ] || { echo "No AppImage was built"; exit 1; }
[ ${#sigs[@]} -gt 0 ] || { echo "No signed AppImage (.sig) was built"; exit 1; }

echo "=== Uploading artifacts for $TAG ==="
gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" --title "JARVIS V2 $TAG" --generate-notes
gh release upload "$TAG" "${files[@]}" "${sigs[@]}" --clobber

echo "=== Generating updater feed (latest.json) ==="
mkdir -p /tmp/jarvis-feed && rm -rf /tmp/jarvis-feed/*
cp "${sigs[@]}" /tmp/jarvis-feed/
gh release view "$TAG" --json assets > /tmp/jarvis-feed/assets.json

node -e '
  const fs = require("fs");
  const ver = "'"$VER"'";
  const sig = (f) => fs.readFileSync("/tmp/jarvis-feed/" + f, "utf8").trim();
  const api = Object.fromEntries(JSON.parse(fs.readFileSync("/tmp/jarvis-feed/assets.json", "utf8")).assets.map((a) => [a.name, a.apiUrl]));
  const link = (f) => { if (!api[f]) throw new Error(`${f} is not on the release`); return api[f]; };
  const platforms = {};
  for (const name of Object.keys(api)) {
    if (!/_amd64\.AppImage$/.test(name) || !fs.existsSync("/tmp/jarvis-feed/" + name + ".sig")) continue;
    platforms["linux-x86_64"] = name;
  }
  if (!Object.keys(platforms).length) {
    console.error("No signed Linux AppImage found on release!");
    process.exit(1);
  }
  const out = { version: ver, notes: `JARVIS V2 ${ver}`, pub_date: new Date().toISOString(), platforms: {} };
  for (const [k, f] of Object.entries(platforms)) out.platforms[k] = { signature: sig(f + ".sig"), url: link(f) };
  fs.writeFileSync("/tmp/jarvis-feed/latest.json", JSON.stringify(out, null, 2));
'

gh release upload "$TAG" /tmp/jarvis-feed/latest.json --clobber
gh release edit "$TAG" --draft=false

echo "=== Updating updates branch ==="
REPO=$(git config --get remote.origin.url | sed -E 's#(https://github.com/|git@github.com:)##; s#\.git$##')
cd /tmp/jarvis-feed
git init -q -b updates
git config user.name "Antigravity"
git config user.email "antigravity@gemini"
git add latest.json
git commit -qm "Update feed: $TAG"
git remote add origin "https://github.com/${REPO}.git"
git push -f origin updates

echo "=== Successfully published $TAG! Application will update automatically. ==="
