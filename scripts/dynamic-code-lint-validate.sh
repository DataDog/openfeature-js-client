#!/bin/bash

# Checks that the lint config still rejects every dynamic-code and HTML sink.
# A Biome upgrade can rename a nursery rule or change plugin matching without an error.

set -euo pipefail

fixture="biome-plugins/test/dynamic-code-sinks.ts.txt"
# The copy must be inside the lint includes, so it goes under packages/.
target="packages/core/src/__dynamic-code-sinks.ts"

cp "$fixture" "$target"
trap 'rm -f "$target"' EXIT

echo "Validating dynamic-code lint rules..."

first_sink_line=$(($(grep -n '^// sinks$' "$fixture" | cut -d: -f1) + 1))
last_line=$(wc -l < "$fixture" | tr -d ' ')

flagged_lines=$(yarn biome lint "$target" --reporter=github --diagnostic-level=error --max-diagnostics=none 2>/dev/null \
  | grep -o '^::error [^:]*line=[0-9]*' | grep -o '[0-9]*$' | sort -un || true)

missing=0
for line in $(seq "$first_sink_line" "$last_line"); do
  if ! grep -qx "$line" <<< "$flagged_lines"; then
    echo "❌ Not flagged: line $line: $(sed -n "${line}p" "$fixture")"
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "The lint config no longer rejects all dynamic-code sinks."
  exit 1
fi

echo "✅ All $((last_line - first_sink_line + 1)) dynamic-code sinks are rejected"
