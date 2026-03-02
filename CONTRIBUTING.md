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

See [AGENTS.md](AGENTS.md) for a step-by-step guide.

**TL;DR:**

```bash
git checkout -b release/v<VERSION> main
git push -u origin release/v<VERSION>
yarn release                              # bumps version, generates changelog, pushes tag
git push origin release/v<VERSION>
# Open a PR, merge it, then create a GitHub Release with tag v<VERSION>
```

Publishing to npm is fully automated by the `release.yaml` workflow when a GitHub Release is created.

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
