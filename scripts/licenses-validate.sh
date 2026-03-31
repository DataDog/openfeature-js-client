#!/bin/bash

set -euo pipefail

## Validates that every npm package in yarn.lock has a corresponding entry in
## LICENSE-3rdparty.csv. This is a lightweight check that runs in CI without
## requiring Python, dd-license-attribution, or a GITHUB_TOKEN.
##
## When this check fails, manually add the missing packages to LICENSE-3rdparty.csv
## and commit the result. An AI coding agent can help with this.

LICENSE_FILE="LICENSE-3rdparty.csv"
LOCKFILE="yarn.lock"

if [ ! -f "$LICENSE_FILE" ]; then
    echo "ERROR: $LICENSE_FILE not found."
    echo "Manually add entries to $LICENSE_FILE. An AI coding agent can help."
    exit 1
fi

if [ ! -f "$LOCKFILE" ]; then
    echo "ERROR: $LOCKFILE not found."
    exit 1
fi

num_licenses=$(wc -l < "$LICENSE_FILE" | tr -d ' ')
if [ "$num_licenses" -eq 0 ]; then
    echo "ERROR: $LICENSE_FILE is empty."
    echo "Manually add entries to $LICENSE_FILE. An AI coding agent can help."
    exit 1
fi

echo "LICENSE-3rdparty.csv has $num_licenses entries."

# Extract workspace package names (our own packages, not third-party).
workspace_packages=$(grep '@workspace:' "$LOCKFILE" | grep '^"' | sed 's/"//g; s/@workspace:.*//' | sort -u)

# Extract all npm package names from yarn.lock (lines starting with " that contain @npm:).
lockfile_packages=$(grep '^"' "$LOCKFILE" | grep '@npm:' | sed 's/"//g; s/@npm:.*//' | sort -u)

# Extract component names from LICENSE-3rdparty.csv (first column, skip header).
csv_components=$(tail -n +2 "$LICENSE_FILE" | cut -d',' -f1 | sed 's/"//g' | sort -u)

# Find packages in yarn.lock that are missing from the CSV (excluding workspaces).
missing=()
while IFS= read -r pkg; do
    # Skip workspace packages.
    if echo "$workspace_packages" | grep -qxF "$pkg"; then
        continue
    fi
    # Check if the package is in the CSV.
    if ! echo "$csv_components" | grep -qxF "$pkg"; then
        missing+=("$pkg")
    fi
done <<< "$lockfile_packages"

if [ ${#missing[@]} -eq 0 ]; then
    echo "All packages in yarn.lock have license entries."
    exit 0
fi

echo ""
echo "ERROR: ${#missing[@]} package(s) in yarn.lock are missing from $LICENSE_FILE:"
echo ""
for pkg in "${missing[@]}"; do
    echo "  - $pkg"
done
echo ""
echo "Manually add the missing packages to $LICENSE_FILE and commit the result."
echo "An AI coding agent can help with this."
exit 1
