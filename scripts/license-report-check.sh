#!/bin/bash

set -euo pipefail

yarn license-report:generate --quiet

### Determine if the license report has changed
if [[ $(git diff -- LICENSE-3rdparty.csv) ]]; then
  echo "Prod dependencies have changed!"
  echo "Please run 'yarn license-report:generate' and commit the changes"
  exit 1
fi

echo "License report has not changed"
