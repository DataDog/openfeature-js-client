# Contributing to OpenFeature JS Client

Thank you for your interest in contributing to the OpenFeature JS Client! This document provides guidelines for contributing to the project, with a focus on the release process.

## Project Structure

This is a monorepo managed with Lerna that contains multiple packages:

- **`@datadog/flagging-core`** - Runtime-agnostic flag-evaluation logic
- **`@datadog/openfeature-browser`** - Browser-specific bindings for OpenFeature

The project uses **fixed versioning**, meaning all packages share the same version number and are released together. The version is managed centrally in `lerna.json`.

## Development Setup

1. **Install dependencies:**

   ```bash
   yarn install
   ```

2. **Build all packages:**

   ```bash
   yarn build
   ```

3. **Run tests:**

   ```bash
   yarn test
   ```

4. **Type checking:**

   ```bash
   yarn typecheck
   ```

5. **Linting:**
   ```bash
   yarn lint
   yarn lint:fix  # Auto-fix issues
   ```

## Release Process

### Prerequisites

- Ensure you're not on the `main` branch (releases should be done from feature branches)
- All tests must pass
- Code must be linted and type-checked
- Changes should be committed and pushed
- Proper GitHub secrets must be configured:
  - `NPM_PUBLISH_TOKEN_FLAGGING_CORE` - Token for publishing core package
  - `NPM_PUBLISH_TOKEN` - Token for publishing browser package

### Build Modes

The project supports different build modes that affect how the SDK version is determined:

#### 1. Development Mode (`dev`)

- **Default mode** when `BUILD_MODE` is not set
- SDK version is set to `"dev"`
- Used during development and testing

#### 2. Release Mode (`release`)

- Used for public releases
- SDK version uses the actual version from `lerna.json`
- This is the mode used for production releases

#### 3. Canary Mode (`canary`)

- Used on staging and production Datadog web app
- SDK version format: `{lerna-version}-{commit-sha}`
- Example: `0.1.0-alpha.2-a1b2c3d4`

### SDK Setups

The project also supports different SDK setups:

- **`npm`** (default) - For npm package distribution
- **`cdn`** - For CDN distribution

### Creating a Release

#### 1. Create a release branch from main

```bash
git checkout main
git pull origin main
git checkout -b release/v<VERSION>
git push -u origin release/v<VERSION>
```

The branch **must** be pushed to the remote before running lerna (lerna requires the branch to exist on origin).

#### 2. Bump version with Lerna

```bash
yarn release
```

This prompts for the new version, updates all `package.json` files and `lerna.json`, generates the CHANGELOG, updates peer dependency versions, and pushes the version tag to origin.

#### 3. Push the release branch and open a PR

```bash
git push origin release/v<VERSION>
gh pr create --draft --title "Release v<VERSION>"
```

#### 4. Publish via GitHub Release

After the PR is merged to main, create a GitHub Release with tag `v<VERSION>` (must match `lerna.json`). The `release.yaml` workflow automatically builds and publishes all packages to npm with the `latest` tag.

### Package-Specific Build Commands

#### Core Package (`@datadog/flagging-core`)

```bash
# Build all formats (CommonJS and ESM)
cd packages/core
yarn build

# Build CommonJS only
yarn build:cjs

# Build ESM only
yarn build:esm

# Create package tarball
yarn pack
```

#### Browser Package (`@datadog/openfeature-browser`)

```bash
# Build all formats (CommonJS, ESM, and bundle)
cd packages/browser
yarn build

# Build bundle for CDN
SDK_SETUP=cdn yarn build:bundle

# Build CommonJS only
yarn build:cjs

# Build ESM only
yarn build:esm

# Create package tarball
yarn pack
```

### Environment Variables

- **`BUILD_MODE`**: Controls the SDK version format
  - `dev` (default) - Development version
  - `release` - Production release version
  - `canary` - Canary version with commit SHA

- **`SDK_SETUP`**: Controls the SDK setup type
  - `npm` (default) - For npm distribution
  - `cdn` - For CDN distribution

### Testing Before Release

```bash
yarn test           # Run all tests
yarn typecheck      # Type checking
yarn lint           # Linting
yarn clean && yarn build && yarn build:bundle  # Build verification
```

### Troubleshooting

- **"please do not release from main branch"** — create a `release/v*` branch first
- **"ENOREMOTEBRANCH"** — push the branch to origin before running lerna version
- **"Release tag doesn't match lerna.json"** — the GitHub Release tag must be exactly `v<VERSION>` matching `lerna.json`
- **npm propagation timeout** — the workflow retries for 5 min; if it fails, check npm status or re-run the workflow

#### Manual Publishing (Emergency Only)

If the automated workflow fails and you need to publish manually:

```bash
BUILD_MODE=release yarn build
yarn version

cd packages/core
npm publish --tag latest

# Wait for npm propagation, then:
cd ../browser
npm publish --tag latest
cd ../node-server
npm publish --tag latest
```

## Third-Party Licenses

All third-party dependency licenses are tracked in `LICENSE-3rdparty.csv`. This file is
auto-generated and **must be kept up to date** whenever dependencies change. CI will fail
if it is stale.

### When to update

Re-generate the file whenever you add, remove, or update a dependency in any `package.json`.

### Prerequisites

| Requirement                | Details                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| **Python 3.11.12**         | `pyenv install 3.11.12 && pyenv local 3.11.12`                                                   |
| **Go 1.23+**               | Required by `dd-license-attribution`                                                             |
| **dd-license-attribution** | `pip install dd-license-attribution` ([repo](https://github.com/DataDog/dd-license-attribution)) |
| **GITHUB_TOKEN**           | See below                                                                                        |

For Datadog employees, see the internal [dd-license-attribution guide](https://datadoghq.atlassian.net/wiki/spaces/OS/pages/4486988521/dd-license-attribution+CLI+Tool+to+Track+3rd+Party+Dependencies+Copyrights).

### Setting GITHUB_TOKEN

If you already use the [GitHub CLI](https://cli.github.com/), the easiest option is:

```bash
export GITHUB_TOKEN=$(gh auth token)
```

Otherwise, create a fine-grained personal access token with read access to **Contents**
and **Metadata** at https://github.com/settings/personal-access-tokens and export it:

```bash
export GITHUB_TOKEN="github_pat_..."
```

### Generating / updating licenses

```bash
export GITHUB_TOKEN=$(gh auth token)
yarn licenses:generate
```

This overwrites `LICENSE-3rdparty.csv` with the latest data. Commit the result.

### Validating licenses locally

```bash
yarn licenses:validate
```

This checks that every npm package in `yarn.lock` has a corresponding entry in the CSV.
No external tools or tokens are needed — it runs in CI the same way. If it fails, run
`yarn licenses:generate` and commit the result.

## Code Style

- Use TypeScript for all new code
- Follow the existing code style and patterns
- Run `yarn lint:fix` before committing
- Ensure all tests pass before submitting changes

## Commit Messages

Follow conventional commit format with gitmoji:

- `✨ feat:` for new features
- `🐛 fix:` for bug fixes
- `📝 docs:` for documentation changes
- `🎨 style:` for formatting changes
- `♻️ refactor:` for code refactoring
- `✅ test:` for test changes
- `👷 chore:` for maintenance tasks

Example: `✨ feat(browser): add new flag evaluation method`
