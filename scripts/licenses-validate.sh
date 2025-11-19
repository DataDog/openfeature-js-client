#!/bin/bash

set -euo pipefail

## This file is meant to be run in CI to verify that the licenses are up to date.

num_licenses=$(wc -l < LICENSE-3rdparty.csv)
if [ "$num_licenses" -eq 0 ]; then
    echo "No licenses found. Run 'yarn licenses:generate' to generate the licenses."
    exit 1
fi

echo "Found $num_licenses licenses."

yarn licenses:generate

num_licenses_expected=$(wc -l < LICENSE-3rdparty.csv)

echo "Expected $num_licenses_expected licenses."

if [ "$num_licenses" -ne "$num_licenses_expected" ]; then
    echo "Packages have been added or removed. Run 'yarn licenses:generate' to update the LICENSE-3rdparty.csv file."
    exit 1
fi

echo "Licenses are up to date."
