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

if [ -n "$(git status --porcelain)" ]; then
    echo "ERROR: Working tree has uncommitted changes"
    echo "Please commit your changes before running this script, as it clones from the local repo"
    exit 1
fi

REPO_URL="https://github.com/DataDog/openfeature-js-client"
REPO_ROOT="$(git rev-parse --show-toplevel)"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

MIRROR_ARGS=()
if [ "$CURRENT_BRANCH" != "main" ]; then
    MIRRORS_FILE="$(mktemp)"
    trap 'rm -f "$MIRRORS_FILE"' EXIT
    cat > "$MIRRORS_FILE" <<EOF
[
    {
        "original_url": "$REPO_URL",
        "mirror_url": "$REPO_ROOT",
        "ref_mapping": {
            "branch:main": "branch:$CURRENT_BRANCH"
        }
    }
]
EOF
    MIRROR_ARGS=(--use-mirrors "$MIRRORS_FILE")
    echo "Using local repo at branch '$CURRENT_BRANCH' instead of remote main"
fi

dd-license-attribution generate-sbom-csv "$REPO_URL" --override-spec .ddla-overrides ${MIRROR_ARGS[@]+"${MIRROR_ARGS[@]}"} > LICENSE-3rdparty.csv
