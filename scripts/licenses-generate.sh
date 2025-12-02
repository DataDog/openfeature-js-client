#!/bin/bash

set -euo pipefail

### Requires python 3.11.12 and dd-license-attribution 
# see https://github.com/DataDog/dd-license-attribution for installation details

### Make sure python version is 3.11.12
if command -v pyenv &> /dev/null; then
    # Use pyenv to set the Python version
    if ! pyenv versions | grep -q "3.11.12"; then
        echo "Python 3.11.12 is not installed via pyenv"
        read -p "Would you like to install Python 3.11.12 now? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "Installing Python 3.11.12..."
            pyenv install 3.11.12
        else
            echo "Please install Python 3.11.12 manually: 'pyenv install 3.11.12'"
            exit 1
        fi
    fi
    pyenv local 3.11.12
    echo "Set Python version to 3.11.12 using pyenv"
else
    # Fallback: check if the correct version is available
    if ! python --version | grep -q "3.11.12"; then
        echo "Python version is not 3.11.12"
        echo "Please install python 3.11.12 or use pyenv: 'pyenv install 3.11.12 && pyenv local 3.11.12'"
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
