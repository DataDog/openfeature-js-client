#!/bin/bash
set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Get the repo root (parent of scripts/)
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Testing @datadog/openfeature-browser package installation..."
echo "Repository root: $REPO_ROOT"
echo ""

# Navigate to test app
TEST_APP_DIR="$REPO_ROOT/test-app"
cd "$TEST_APP_DIR"

# Clean up previous installation
echo "Cleaning up previous installation..."
rm -rf node_modules package-lock.json yarn.lock *.tgz

# Create empty yarn.lock if it doesn't exist (required for yarn workspaces to treat this as separate project)
touch yarn.lock

# Pack the core package (since browser depends on it)
echo "Packing @datadog/flagging-core..."
cd "$REPO_ROOT/packages/core"
yarn pack --filename "$TEST_APP_DIR/core.tgz" > /dev/null 2>&1

# Install the packed core into browser package (so browser packs with the correct core version)
echo "Installing packed core into browser package..."
cd "$REPO_ROOT/packages/browser"

# Save original package.json and yarn.lock
cp package.json package.json.backup


# Install the tarball temporarily
yarn add "@datadog/flagging-core@file:$TEST_APP_DIR/core.tgz" --silent

# Pack the browser package
echo "Packing @datadog/openfeature-browser..."
yarn pack --filename "$TEST_APP_DIR/browser.tgz" > /dev/null 2>&1

# Restore browser package to original state using git
echo "Restoring browser package..."
rm package.json
mv package.json.backup package.json

cd "$REPO_ROOT"

# Return to test app
cd "$TEST_APP_DIR"

# Install dependencies (ignore workspace context from parent)
# Note: --no-immutable allows lockfile changes, which is needed because tarball checksums change
echo "Installing dependencies..."
yarn install --no-immutable --silent

# Install the packed packages
echo "Installing @datadog/flagging-core from tarball..."
yarn add @datadog/flagging-core@file:./core.tgz --silent

echo "Installing @datadog/openfeature-browser from tarball..."
yarn add @datadog/openfeature-browser@file:./browser.tgz --silent

# Build the app
echo "Building test app..."
yarn build

echo ""
echo "✓ All tests passed! Package can be installed and the app builds successfully."
echo ""
echo "To run the test app locally:"
echo "  cd test-app"
echo "  yarn dev"
