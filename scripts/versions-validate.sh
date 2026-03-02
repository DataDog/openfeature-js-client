#!/bin/bash

set -euo pipefail

echo "Validating internal dependency versions..."

mismatches=()

# For each package, check that its dependencies on internal packages
# match the actual version in that dependency's package.json
for package_dir in packages/*/; do
  package_json="$package_dir/package.json"
  if [ ! -f "$package_json" ]; then
    continue
  fi

  package_name=$(node -p "require('./$package_json').name")

  # Check dependencies and peerDependencies for internal @datadog/ packages
  for dep_type in dependencies peerDependencies; do
    # Get internal deps (packages that exist in our monorepo)
    internal_deps=$(node -p "
      const pkg = require('./$package_json');
      const deps = pkg['$dep_type'] || {};
      const internal = Object.keys(deps).filter(d => d.startsWith('@datadog/'));
      internal.join(',')
    " 2>/dev/null || echo "")

    if [ -z "$internal_deps" ]; then
      continue
    fi

    IFS=',' read -ra dep_names <<< "$internal_deps"
    for dep_name in "${dep_names[@]}"; do
      if [ -z "$dep_name" ]; then
        continue
      fi

      # Find the directory for this internal dep
      dep_dir=$(node -p "
        const fs = require('fs');
        const dirs = fs.readdirSync('packages', { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        const match = dirs.find(d => {
          try {
            return require('./packages/' + d + '/package.json').name === '$dep_name';
          } catch { return false; }
        });
        match || ''
      " 2>/dev/null || echo "")

      if [ -z "$dep_dir" ]; then
        # Not an internal monorepo package, skip
        continue
      fi

      # Get the actual version from the dependency's package.json
      actual_version=$(node -p "require('./packages/$dep_dir/package.json').version")
      # Get the declared version in the consuming package
      declared_version=$(node -p "require('./$package_json')['$dep_type']['$dep_name']")

      if [ "$declared_version" != "$actual_version" ]; then
        mismatches+=("$package_name $dep_type '$dep_name' is '$declared_version' but actual version is '$actual_version'")
      else
        echo "✓ $package_name $dep_type '$dep_name': $declared_version"
      fi
    done
  done
done

# Report results
if [ ${#mismatches[@]} -gt 0 ]; then
  echo ""
  echo "ERROR: Internal dependency version mismatches found:"
  for mismatch in "${mismatches[@]}"; do
    echo "  - $mismatch"
  done
  exit 1
fi

echo ""
echo "All internal dependency versions are consistent."
