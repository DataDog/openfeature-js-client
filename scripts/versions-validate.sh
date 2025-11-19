#!/bin/bash

set -euo pipefail

package_json_files=$(find . -type f | grep package.json | grep -Ev '(\.git|node_modules|test-app)')

echo "Validating package versions..."

reference_version=""
mismatches=()

for file in $package_json_files; do
  # Extract version from package.json if it exists
  version=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$file" | grep -o '"[0-9][^"]*"' | tr -d '"' || echo "")

  # Skip files without a version field (like the root monorepo package.json)
  if [ -z "$version" ]; then
    continue
  fi

  # Set the reference version from the first file with a version
  if [ -z "$reference_version" ]; then
    reference_version="$version"
    echo "Reference version: $version (from $file)"
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
