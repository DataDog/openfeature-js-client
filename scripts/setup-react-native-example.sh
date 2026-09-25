#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/test-app-react-native"
APP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flagging-core-react-native.XXXXXX")"

# Intentionally retain this directory: the developer will run Expo from here.
# A fresh directory/tarball per run avoids stale npm installs of the same version.
echo "Preparing the manual React Native app in $APP_DIR"
cp "$FIXTURE_DIR/manual/"* "$APP_DIR/"
cp "$FIXTURE_DIR/configurations.js" "$APP_DIR/"

echo "Building and packing @datadog/flagging-core..."
cd "$REPO_ROOT/packages/core"
node "$REPO_ROOT/.yarn/releases/yarn-4.10.3.cjs" pack --filename "$APP_DIR/core.tgz"

node - "$REPO_ROOT" "$APP_DIR" <<'NODE'
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const [repo, app] = process.argv.slice(2)
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const info = {
  commit: git('rev-parse', '--short', 'HEAD'),
  dirty: git('status', '--porcelain').length > 0,
  packedAt: new Date().toISOString(),
  sha256: createHash('sha256').update(fs.readFileSync(path.join(app, 'core.tgz'))).digest('hex'),
}
fs.writeFileSync(path.join(app, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`)
NODE

cd "$APP_DIR"
echo "Installing the tarball and Expo app (no workspace links)..."
npm install --ignore-scripts --no-audit --no-fund
npm run typecheck

printf '\nApp ready. In your terminal, run:\n\n  cd %q\n  npm start\n\n' "$APP_DIR"
printf '%s\n' \
  'Press i for the iOS simulator, a for Android, or scan the QR code with Expo Go.' \
  'The screen should say Hermes and ALL CHECKS PASSED.' \
  'Stop Metro before switching modes: npm run start:modern or npm run start:legacy-esm.' \
  'After changing SDK source, rerun yarn example:react-native from the repository.' \
  "This app directory is retained until you remove it: $APP_DIR"
