#!/bin/bash

set -euo pipefail

PYTHON_VERSION="3.11.12"

### Requires python 3.11.12 and dd-license-attribution
# see https://github.com/DataDog/dd-license-attribution for installation details

### Check Python version
if ! python --version 2>&1 | grep -q "${PYTHON_VERSION}"; then
    echo "ERROR: Python version ${PYTHON_VERSION} is required"
    echo "Current version: $(python --version 2>&1)"
    echo "Please install Python ${PYTHON_VERSION}"
    if command -v pyenv &> /dev/null; then
        echo "  Using pyenv: pyenv install ${PYTHON_VERSION} && pyenv local ${PYTHON_VERSION}"
    fi
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

dd-license-attribution generate-sbom-csv https://github.com/DataDog/openfeature-js-client --override-spec .ddla-overrides > LICENSE-3rdparty.csv
