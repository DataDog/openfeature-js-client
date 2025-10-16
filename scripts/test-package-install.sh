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
TEST_APP_DIR="$REPO_ROOT/packages/test-app"
cd "$TEST_APP_DIR"

# Clean up previous installation
echo "Cleaning up previous installation..."
rm -rf node_modules package-lock.json yarn.lock *.tgz

# Pack the core package (since browser depends on it)
echo "Packing @datadog/flagging-core..."
cd "$REPO_ROOT/packages/core"
yarn pack --filename "$TEST_APP_DIR/core.tgz" > /dev/null 2>&1

# Pack the browser package
echo "Packing @datadog/openfeature-browser..."
cd "$REPO_ROOT/packages/browser"
yarn pack --filename "$TEST_APP_DIR/browser.tgz" > /dev/null 2>&1

# Return to test app
cd "$TEST_APP_DIR"

# Install dependencies
echo "Installing dependencies..."
yarn install --silent

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
echo "  cd packages/test-app"
echo "  yarn dev"
