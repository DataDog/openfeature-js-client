#!/bin/bash

set -euo pipefail

## This file is meant to be run in CI to verify that the LICENSE-3rdparty.csv
## file is up to date with the current project dependencies.
##
## Prerequisites (same as licenses-generate.sh):
##   - Python 3.11.12
##   - dd-license-attribution (https://github.com/DataDog/dd-license-attribution)
##   - GITHUB_TOKEN environment variable
##
## See CONTRIBUTING.md for setup instructions.

LICENSE_FILE="LICENSE-3rdparty.csv"

if [ ! -f "$LICENSE_FILE" ]; then
    echo "ERROR: $LICENSE_FILE not found."
    echo "Run 'yarn licenses:generate' to create it."
    exit 1
fi

num_licenses=$(wc -l < "$LICENSE_FILE")
if [ "$num_licenses" -eq 0 ]; then
    echo "ERROR: $LICENSE_FILE is empty."
    echo "Run 'yarn licenses:generate' to populate it."
    exit 1
fi

echo "Current $LICENSE_FILE has $num_licenses lines."

# Save the committed file, regenerate, and compare.
cp "$LICENSE_FILE" "${LICENSE_FILE}.bak"

yarn licenses:generate

if diff -q "${LICENSE_FILE}.bak" "$LICENSE_FILE" > /dev/null 2>&1; then
    echo "Licenses are up to date."
    rm -f "${LICENSE_FILE}.bak"
    exit 0
fi

echo ""
echo "ERROR: $LICENSE_FILE is out of date."
echo ""
echo "Diff (committed vs expected):"
diff --unified=3 "${LICENSE_FILE}.bak" "$LICENSE_FILE" || true

# Restore the original so the working tree stays clean.
mv "${LICENSE_FILE}.bak" "$LICENSE_FILE"

echo ""
echo "Run 'yarn licenses:generate' locally and commit the updated $LICENSE_FILE."
exit 1
