#!/usr/bin/env bash
# verify-flag-evaluation-endpoint.sh
#
# Regression test for the flagEvaluationEndpointBuilder dead-code removal.
#
# Background:
#   packages/browser/src/domain/configuration.ts previously imported
#   createEndpointBuilder from @datadog/browser-core/cjs/domain/configuration
#   (a private deep subpath) and used it to set flagEvaluationEndpointBuilder.
#   That call was always overridden by ...baseConfiguration (which already
#   contains flagEvaluationEndpointBuilder via TransportConfiguration).
#   The dead import caused ESM build output to contain /cjs/ subpath references,
#   breaking bundler tree-shaking in Vite/Rollup/webpack ESM mode.
#
# This script verifies:
#   1. No /cjs/ deep subpath references remain in compiled output.
#   2. flagEvaluationEndpointBuilder is populated and builds a correct URL.
#
# Usage: bash scripts/verify-flag-evaluation-endpoint.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BROWSER_PKG="$REPO_ROOT/packages/browser"
PASS=0
FAIL=0

fail() {
  echo "FAIL: $1"
  FAIL=$((FAIL + 1))
}

pass() {
  echo "PASS: $1"
  PASS=$((PASS + 1))
}

echo "=== Building @datadog/openfeature-browser ==="
cd "$BROWSER_PKG"
yarn build > /dev/null 2>&1
echo "Build complete."
echo ""

# -----------------------------------------------------------------------
# Check 1: No /cjs/ deep subpath references in compiled configuration.js (CJS)
# -----------------------------------------------------------------------
# Regression for: configuration.ts previously imported createEndpointBuilder from
# @datadog/browser-core/cjs/domain/configuration (a private deep subpath). That
# import was emitted verbatim into compiled output, breaking ESM bundlers.
echo "--- Check 1: CJS configuration output has no @datadog/*/cjs/ references ---"
if grep "@datadog/[^\"']*/cjs/" \
    "$BROWSER_PKG/cjs/domain/configuration.js" \
    "$BROWSER_PKG/cjs/domain/configuration.d.ts" \
    2>/dev/null | grep -v "^Binary"; then
  fail "CJS configuration output contains @datadog/*/cjs/ deep subpath references"
else
  pass "CJS configuration output is clean"
fi

# -----------------------------------------------------------------------
# Check 2: No /cjs/ deep subpath references in compiled configuration.js (ESM)
# -----------------------------------------------------------------------
echo "--- Check 2: ESM configuration output has no @datadog/*/cjs/ references ---"
if grep "@datadog/[^\"']*/cjs/" \
    "$BROWSER_PKG/esm/domain/configuration.js" \
    "$BROWSER_PKG/esm/domain/configuration.d.ts" \
    2>/dev/null | grep -v "^Binary"; then
  fail "ESM configuration output contains @datadog/*/cjs/ deep subpath references (bundler breakage)"
else
  pass "ESM configuration output is clean"
fi

# -----------------------------------------------------------------------
# Check 3: flagEvaluationEndpointBuilder is populated and correct
# -----------------------------------------------------------------------
echo "--- Check 3: flagEvaluationEndpointBuilder is populated and returns correct URL ---"
if node --input-type=commonjs << 'EOF'
// browser-core accesses document.cookie during session strategy selection.
// This stub is enough to prevent a ReferenceError in Node.js; cookies will
// not be authorized (session store ends up undefined), which is fine here
// because these checks only verify flagEvaluationEndpointBuilder, not session state.
global.document = { cookie: '' }
const { validateAndBuildFlaggingConfiguration } = require('./cjs/domain/configuration.js')

const config = validateAndBuildFlaggingConfiguration({
  clientToken: 'pub_testtoken',
  applicationId: 'test-app-id',
  site: 'datadoghq.com',
})

if (!config) {
  console.error('FAIL: validateAndBuildFlaggingConfiguration returned undefined')
  process.exit(1)
}

const builder = config.flagEvaluationEndpointBuilder
if (!builder) {
  console.error('FAIL: flagEvaluationEndpointBuilder is not set on config')
  process.exit(1)
}

const url = builder.build('fetch', { data: '', bytesCount: 0, retry: undefined, encoding: undefined })
if (!url.includes('/api/v2/flagevaluation')) {
  console.error('FAIL: URL does not contain /api/v2/flagevaluation. Got: ' + url)
  process.exit(1)
}
if (!url.includes('browser-intake-datadoghq.com')) {
  console.error('FAIL: URL does not use expected intake host. Got: ' + url)
  process.exit(1)
}

console.log('PASS: flagEvaluationEndpointBuilder works correctly')
console.log('      URL: ' + url.split('?')[0])
EOF
then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Check 4: flagEvaluationEndpointBuilder tracks the track type correctly
# -----------------------------------------------------------------------
echo "--- Check 4: trackType is 'flagevaluation' ---"
if node --input-type=commonjs << 'EOF'
// See check 3 comment for why the document stub is needed.
global.document = { cookie: '' }
const { validateAndBuildFlaggingConfiguration } = require('./cjs/domain/configuration.js')

const config = validateAndBuildFlaggingConfiguration({
  clientToken: 'pub_testtoken',
  applicationId: 'test-app-id',
  site: 'datadoghq.com',
})

const trackType = config && config.flagEvaluationEndpointBuilder && config.flagEvaluationEndpointBuilder.trackType
if (trackType !== 'flagevaluation') {
  console.error('FAIL: trackType is "' + trackType + '", expected "flagevaluation"')
  process.exit(1)
}
console.log('PASS: trackType is "flagevaluation"')
EOF
then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
