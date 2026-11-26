#!/bin/bash
# Builds and publishes a signed release directly from this machine to GitHub Releases & the updates feed.
# Usage: ./publish-local.sh
set -euo pipefail
cd "$(dirname "$0")"

# 1. Find the signing key: TAURI_SIGNING_PRIVATE_KEY (a path to a key file, or the base64 key itself), else
#    ~/.gg/tauri-signing.key. tauri-cli decodes TAURI_SIGNING_PRIVATE_KEY as base64 of the *key file's text*,
#    so a file that still has its "untrusted comment:" line is base64'd here, while one that is already base64
#    is passed through. The key must be an encrypted one: tauri-cli refuses a plain minisign key.
KEY_FILE="${TAURI_SIGNING_KEY_FILE:-$HOME/.gg/tauri-signing.key}"
KEY_SRC="${TAURI_SIGNING_PRIVATE_KEY:-}"
[ -z "$KEY_SRC" ] && [ -f "$KEY_FILE" ] && KEY_SRC="$KEY_FILE"
if [ -z "$KEY_SRC" ]; then
  echo "::error:: TAURI_SIGNING_PRIVATE_KEY is required to sign the update bundle."
  echo "Put the updater's private key in $KEY_FILE (or set TAURI_SIGNING_PRIVATE_KEY to its path)."
  exit 1
fi
if [ -f "$KEY_SRC" ]; then
  if head -n1 "$KEY_SRC" | grep -q '^untrusted comment:'; then
    TAURI_SIGNING_PRIVATE_KEY="$(base64 -w0 "$KEY_SRC")"
  else
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_SRC")"
  fi
else
  TAURI_SIGNING_PRIVATE_KEY="$KEY_SRC"
fi
export TAURI_SIGNING_PRIVATE_KEY
if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ] && [ -f "$HOME/.gg/tauri-signing.pass" ]; then
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$HOME/.gg/tauri-signing.pass")"
fi

VER=$(node -p "require('./src-tauri/tauri.conf.json').version")
TAG="v$VER"
echo "=== Building JARVIS V2 $TAG locally ==="
export TAURI_BUNDLES="appimage"

# 2. Fail fast if the key cannot sign, instead of after a five-minute build: a throwaway file signed with
#    the same key and password the build will use.
PREFLIGHT="$(mktemp -d)"
trap 'rm -rf "$PREFLIGHT"' EXIT
printf 'jarvis %s\n' "$VER" > "$PREFLIGHT/preflight.txt"
if ! (cd "$PREFLIGHT" && cargo tauri signer sign --app-version "$VER" preflight.txt >/dev/null 2>"$PREFLIGHT/err"); then
  echo "::error:: the updater key can't sign: $(tail -2 "$PREFLIGHT/err" | tr '\n' ' ')"
  echo "An encrypted key is required (tauri-cli refuses a plain minisign key); ~/.gg/tauri-signing.key + .pass hold it."
  exit 1
fi

# 3. Build local bundle (tauri signs the AppImage with the same key)
./build.sh release

# 4. Verify built artifacts
B="src-tauri/target/release/bundle/appimage"
files=($B/*.AppImage)
sigs=($B/*.AppImage.sig)
[ ${#files[@]} -gt 0 ] || { echo "No AppImage was built"; exit 1; }
[ ${#sigs[@]} -gt 0 ] || { echo "No signed AppImage (.sig) was built"; exit 1; }
for f in "${files[@]}"; do [ -s "$f.sig" ] || { echo "$f has an empty signature"; exit 1; }; done

# 5. Upload to a *draft* release: the update-feed workflow runs on "published", so it must not see the tag
#    before the AppImage, its signature and latest.json are all on it.
echo "=== Uploading artifacts for $TAG ==="
gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" --draft --title "JARVIS V2 $TAG" --generate-notes
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
