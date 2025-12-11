#!/bin/bash

set -euo pipefail

PYTHON_VERSION="3.11.12"

### Requires python 3.11.12 and dd-license-attribution
# see https://github.com/DataDog/dd-license-attribution for installation details

### Make sure python version is 3.11.12
if command -v pyenv &> /dev/null; then
    # Use pyenv to set the Python version
    if ! pyenv versions | grep "${PYTHON_VERSION}" > /dev/null; then
        echo "Python ${PYTHON_VERSION} is not installed via pyenv"
        read -p "Would you like to install Python ${PYTHON_VERSION} now? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "Installing Python ${PYTHON_VERSION}..."
            pyenv install ${PYTHON_VERSION}
        else
            echo "Please install Python ${PYTHON_VERSION} manually: 'pyenv install ${PYTHON_VERSION}'"
            exit 1
        fi
    fi
    pyenv local ${PYTHON_VERSION}
    echo "Set Python version to ${PYTHON_VERSION} using pyenv"
else
    # Fallback: check if the correct version is available
    if ! python --version | grep "${PYTHON_VERSION}" > /dev/null; then
        echo "Python version is not ${PYTHON_VERSION}"
        echo "Please install python ${PYTHON_VERSION} or use pyenv: 'pyenv install ${PYTHON_VERSION} && pyenv local ${PYTHON_VERSION}'"
        exit 1
    fi
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
