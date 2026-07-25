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

cp "$FIXTURE_DIR/package.json" "$FIXTURE_DIR/index.js" "$FIXTURE_DIR/metro.config.js" "$SMOKE_DIR/"

echo "Packing @datadog/flagging-core..."
cd "$REPO_ROOT/packages/core"
node "$REPO_ROOT/.yarn/releases/yarn-4.10.3.cjs" pack --filename "$SMOKE_DIR/core.tgz" >/dev/null

echo "Installing the React Native Metro smoke fixture..."
cd "$SMOKE_DIR"
npm install --ignore-scripts --no-audit --no-fund

echo "Bundling the packed core package with the React Native Metro configuration..."
mkdir -p dist
for platform in android ios; do
  ./node_modules/.bin/metro build index.js \
    --config metro.config.js \
    --platform "$platform" \
    --dev false \
    --minify false \
    --max-workers 2 \
    --out "dist/index.$platform.bundle.js"
done

echo "Executing the Metro bundle without TextEncoder, TextDecoder, or BigInt..."
node dist/index.android.bundle.js
