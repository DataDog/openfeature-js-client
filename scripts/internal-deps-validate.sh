#!/bin/bash

set -euo pipefail

echo "Validating internal dependencies use exact versions..."
echo ""

# Build list of internal package names from this monorepo
internal_packages=$(node -e "
  const fs = require('fs');
  const path = require('path');
  fs.readdirSync('packages').forEach(dir => {
    const pkgPath = path.join('packages', dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = require('./' + pkgPath);
      console.log(pkg.name);
    }
  });
")

errors=()

for pkg_dir in packages/*/; do
  pkg_json="$pkg_dir/package.json"

  if [ ! -f "$pkg_json" ]; then
    continue
  fi

  pkg_name=$(basename "$pkg_dir")

  # Check for internal monorepo dependencies with version ranges (^, ~, >=, etc.)
  # Uses node to parse JSON properly instead of grep
  ranges=$(node -e "
    const pkg = require('./$pkg_json');
    const internalPkgs = new Set(process.argv.slice(1));
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
    Object.entries(deps || {})
      .filter(([name, ver]) => internalPkgs.has(name) && /^[\^~>=<]/.test(ver))
      .forEach(([name, ver]) => console.log(name + ': ' + ver));
  " $internal_packages 2>/dev/null || true)

  if [ -n "$ranges" ]; then
    while IFS= read -r line; do
      errors+=("$pkg_name: $line")
    done <<< "$ranges"
  else
    echo "✓ $pkg_name: all @datadog/* dependencies use exact versions"
  fi
done

if [ ${#errors[@]} -gt 0 ]; then
  echo ""
  echo "ERROR: Found @datadog/* dependencies with version ranges:"
  for err in "${errors[@]}"; do
    echo "  - $err"
  done
  echo ""
  echo "Internal dependencies should use exact versions (e.g., \"1.2.1\" not \"^1.2.1\")"
  echo "This ensures consumers get the tested combination of package versions."
  exit 1
fi

echo ""
echo "All internal dependencies use exact versions"
