#!/bin/bash
set -e

# Test @datadog/openfeature-node-server package installation scenarios
#
# Usage:
#   ./scripts/test-node-package-install.sh                    # Test without OF deps (default)
#   ./scripts/test-node-package-install.sh --with-openfeature # Test with latest OF deps
#   OF_SERVER_SDK_VERSION=1.18.0 OF_CORE_VERSION=1.8.0 ./scripts/test-node-package-install.sh --with-openfeature
#
# Environment variables:
#   OF_SERVER_SDK_VERSION - Version of @openfeature/server-sdk (default: latest)
#   OF_CORE_VERSION       - Version of @openfeature/core (default: latest)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_APP_DIR="$REPO_ROOT/test-app-node"

# Parse arguments
WITH_OPENFEATURE=false
for arg in "$@"; do
  case $arg in
    --with-openfeature)
      WITH_OPENFEATURE=true
      shift
      ;;
  esac
done

# Version defaults
OF_SERVER_SDK_VERSION="${OF_SERVER_SDK_VERSION:-latest}"
OF_CORE_VERSION="${OF_CORE_VERSION:-latest}"

echo "=============================================="
echo "Testing @datadog/openfeature-node-server"
echo "=============================================="
echo "Repository root: $REPO_ROOT"
echo "With OpenFeature: $WITH_OPENFEATURE"
if [ "$WITH_OPENFEATURE" = true ]; then
  echo "  @openfeature/server-sdk: $OF_SERVER_SDK_VERSION"
  echo "  @openfeature/core: $OF_CORE_VERSION"
fi
echo ""

# Navigate to test app
cd "$TEST_APP_DIR"

# Clean up previous installation
echo "Cleaning up previous installation..."
rm -rf node_modules package-lock.json yarn.lock *.tgz

# Reset package.json to base state (remove any OF deps added from previous runs)
cat > package.json << 'PKGJSON'
{
  "name": "test-app-node",
  "version": "1.0.0",
  "private": true,
  "description": "Test app for validating @datadog/openfeature-node-server installation scenarios",
  "scripts": {
    "test": "node test.js"
  },
  "dependencies": {
    "@datadog/flagging-core": "file:./core.tgz",
    "@datadog/openfeature-node-server": "file:./node-server.tgz"
  }
}
PKGJSON

# Create empty yarn.lock (required for yarn to treat this as separate project)
touch yarn.lock

# Pack the core package
echo "Packing @datadog/flagging-core..."
cd "$REPO_ROOT/packages/core"
yarn pack --filename "$TEST_APP_DIR/core.tgz" > /dev/null 2>&1

# Install the packed core into node-server package temporarily
echo "Installing packed core into node-server package..."
cd "$REPO_ROOT/packages/node-server"

# Save original package.json
cp package.json package.json.backup

# Install the tarball temporarily
yarn add "@datadog/flagging-core@file:$TEST_APP_DIR/core.tgz" --silent

# Pack the node-server package
echo "Packing @datadog/openfeature-node-server..."
yarn pack --filename "$TEST_APP_DIR/node-server.tgz" > /dev/null 2>&1

# Restore node-server package to original state
echo "Restoring node-server package..."
rm package.json
mv package.json.backup package.json

cd "$REPO_ROOT"

# Return to test app and install
cd "$TEST_APP_DIR"

echo "Installing base dependencies..."
yarn install --no-immutable --silent

echo "Installing @datadog/flagging-core from tarball..."
yarn add @datadog/flagging-core@file:./core.tgz --silent

echo "Installing @datadog/openfeature-node-server from tarball..."
yarn add @datadog/openfeature-node-server@file:./node-server.tgz --silent

# Conditionally install OpenFeature dependencies
if [ "$WITH_OPENFEATURE" = true ]; then
  echo ""
  echo "Installing OpenFeature dependencies..."

  if [ "$OF_SERVER_SDK_VERSION" = "latest" ]; then
    yarn add @openfeature/server-sdk --silent
  else
    yarn add "@openfeature/server-sdk@$OF_SERVER_SDK_VERSION" --silent
  fi

  if [ "$OF_CORE_VERSION" = "latest" ]; then
    yarn add @openfeature/core --silent
  else
    yarn add "@openfeature/core@$OF_CORE_VERSION" --silent
  fi
fi

node "$REPO_ROOT/scripts/assert-node-package-purity.js" node_modules

# Run tests
echo ""
echo "Running tests..."
echo ""
yarn test

echo ""
if [ "$WITH_OPENFEATURE" = true ]; then
  echo "Tests completed with OpenFeature dependencies installed"
else
  echo "Tests completed without OpenFeature dependencies"
  echo ""
  echo "To test with OpenFeature deps:"
  echo "  ./scripts/test-node-package-install.sh --with-openfeature"
  echo ""
  echo "To test with specific versions:"
  echo "  OF_SERVER_SDK_VERSION=1.18.0 OF_CORE_VERSION=1.8.0 ./scripts/test-node-package-install.sh --with-openfeature"
fi
echo ""
