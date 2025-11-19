#!/bin/bash

set -euo pipefail

package_json_files=$(find . -type f | grep package.json | grep -Ev '(\.git|node_modules|test-app)')

echo "Validating package versions..."

# Set reference version from lerna.json
reference_version=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' lerna.json | grep -o '"[0-9][^"]*"' | tr -d '"')

if [ -z "$reference_version" ]; then
  echo "ERROR: Could not read version from lerna.json"
  exit 1
fi

echo "Reference version: $reference_version (from lerna.json)"
echo ""

mismatches=()

for file in $package_json_files; do
  # Extract version from package.json if it exists
  version=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$file" | grep -o '"[0-9][^"]*"' | tr -d '"' || echo "")

  # Skip files without a version field (like the root monorepo package.json)
  if [ -z "$version" ]; then
    continue
  fi

  # Compare against reference version
  if [ "$version" != "$reference_version" ]; then
    mismatches+=("$file has version $version (expected $reference_version)")
  else
    echo "✓ $file: $version"
  fi
done

# Report results
if [ ${#mismatches[@]} -gt 0 ]; then
  echo ""
  echo "ERROR: Version mismatches found:"
  for mismatch in "${mismatches[@]}"; do
    echo "  - $mismatch"
  done
  exit 1
fi

echo ""
echo "All package versions match: $reference_version"
