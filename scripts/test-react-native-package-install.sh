#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/test-app-react-native"
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openfeature-react-native-smoke.XXXXXX")"

cleanup() {
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT

cp "$FIXTURE_DIR/package.json" "$FIXTURE_DIR/index.js" "$SMOKE_DIR/"

echo "Packing @datadog/flagging-core..."
cd "$REPO_ROOT/packages/core"
node "$REPO_ROOT/.yarn/releases/yarn-4.10.3.cjs" pack --filename "$SMOKE_DIR/core.tgz" >/dev/null

echo "Installing the React Native Metro smoke fixture..."
cd "$SMOKE_DIR"
npm install --ignore-scripts --no-audit --no-fund

echo "Bundling the packed core package for Android with Metro..."
mkdir -p dist
./node_modules/.bin/metro build index.js \
  --platform android \
  --dev false \
  --minify false \
  --max-workers 2 \
  --out dist/index.bundle.js

echo "Executing the Metro bundle without TextEncoder, TextDecoder, or BigInt..."
node dist/index.bundle.js
