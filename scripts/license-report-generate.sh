#!/bin/bash

set -euo pipefail

QUIET=false
if [[ $# -gt 0 && $1 == "--quiet" ]]; then
    QUIET=true
fi

if [[ $QUIET == false ]]; then
    echo "Generating license report..."
fi

echo 'Component,Origin,License,Copyright' > LICENSE-3rdparty.csv
find . -type f -name package.json \
    | grep -v node_modules \
    | grep -v test-app \
    | xargs -I {} yarn license-report --only=prod --package={} \
    | grep -v @datadog/flagging-core \
    | sort \
    | uniq \
>> LICENSE-3rdparty.csv

if [[ $QUIET == false ]]; then
    echo "License report generated in LICENSE-3rdparty.csv"
fi
