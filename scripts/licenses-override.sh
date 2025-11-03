#!/bin/bash

set -euo pipefail

### Requires python 3.11.12 and dd-license-attribution 
# see https://github.com/DataDog/dd-license-attribution for installation details

### Make sure python version is 3.11.12
if ! python --version | grep -q "3.11.12"; then
    echo "Python version is not 3.11.12"
    echo "Please install python 3.11.12"
    exit 1
fi

if ! command -v dd-license-attribution &> /dev/null; then
    echo "dd-license-attribution could not be found"
    echo "see https://github.com/DataDog/dd-license-attribution for installation instructions"
    exit 1
fi

if [ -z "$GITHUB_TOKEN" ]; then
    echo "GITHUB_TOKEN is not set"
    echo "Must create a fine-grained personal access token with read access to \"Contents\" and \"Metadata\""
    echo "see https://github.com/settings/personal-access-tokens"
    exit 1
fi

dd-license-attribution generate-overrides LICENSE-3rdparty.csv
