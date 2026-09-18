#!/bin/bash

set -euo pipefail

package_json_files=$(find . -type f | grep package.json | grep -Ev '(\.git|node_modules|test-app)')

echo "Validating package versions..."

# Check if using independent or fixed versioning
lerna_version=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' lerna.json | grep -o '"[^"]*"$' | tr -d '"')

if [ "$lerna_version" = "independent" ]; then
  echo "Using independent versioning"
  echo ""

  # For independent versioning, just validate each package has a valid semver version
  for file in $package_json_files; do
    version=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$file" | grep -o '"[0-9][^"]*"' | tr -d '"' || echo "")

    if [ -z "$version" ]; then
      continue
    fi

    # Basic semver validation (x.y.z with optional prerelease)
    if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
      echo "✓ $file: $version"
    else
      echo "ERROR: $file has invalid version: $version"
      exit 1
    fi
  done

  echo ""
  echo "All package versions are valid semver"
else
  # Fixed versioning - all packages must match lerna.json version
  reference_version=$(echo "$lerna_version" | grep -o '[0-9][^"]*' || echo "")

  if [ -z "$reference_version" ]; then
    echo "ERROR: Could not read version from lerna.json"
    exit 1
  fi

  echo "Reference version: $reference_version (from lerna.json)"
  echo ""

  mismatches=()

  for file in $package_json_files; do
    version=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$file" | grep -o '"[0-9][^"]*"' | tr -d '"' || echo "")

    if [ -z "$version" ]; then
      continue
    fi

    if [ "$version" != "$reference_version" ]; then
      mismatches+=("$file has version $version (expected $reference_version)")
    else
      echo "✓ $file: $version"
    fi
  done

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
fi
