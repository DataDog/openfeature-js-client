# Contributing to OpenFeature JS Client

Thank you for your interest in contributing to the OpenFeature JS Client! This document provides guidelines for contributing to the project, with a focus on the release process.

## Project Structure

This is a monorepo managed with Lerna that contains multiple packages:

- **`@datadog/flagging-core`** - Runtime-agnostic flag-evaluation logic
- **`@datadog/openfeature-browser`** - Browser-specific bindings for OpenFeature
- **`@datadog/openfeature-node-server`** - Node.js server bindings for OpenFeature

The project uses **independent versioning**, meaning each package can have its own version number. Internal dependencies (e.g., `@datadog/flagging-core`) are pinned to exact versions on release (via `command.version.exact` in `lerna.json`) to prevent version skew.

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

All packages are published with the `latest` npm tag.

#### Step 1: Prepare for Release

1. **Switch to a feature branch:**
   ```bash
   git checkout -b release/v1.2.3
   ```

#### Step 2: Pin Internal Dependencies

2. **Ensure internal dependencies use exact versions:**

   ```bash
   yarn node ./scripts/release/update-peer-dependency-versions.js
   ```

   This script reads each package's current version and updates internal dependencies (like `@datadog/flagging-core`) to use exact versions without the `^` prefix. This prevents version skew between packages.

   After running, verify the changes:
   ```bash
   git diff packages/*/package.json
   ```

   You should see changes like:
   ```diff
   -    "@datadog/flagging-core": "^1.2.1"
   +    "@datadog/flagging-core": "1.2.1"
   ```

#### Step 3: Version the Package(s)

3. **Update the version using the CLI:**

   **For independent releases (recommended):**
   ```bash
   yarn release
   ```

   This command:
   - Validates you're not on the `main` branch
   - Runs `lerna version --exact`
   - Prompts for version updates only for **changed** packages
   - Creates version commits and tags per package (e.g., `@datadog/openfeature-node-server@1.3.0`)
   - Pushes version tags to Github

   **For unified releases (all packages with same version):**
   ```bash
   yarn release:all
   ```

   This command:
   - Same as above, but uses `--force-publish` to prompt for **all** packages
   - Use this when you want to release all packages together with the same version

#### Step 4: Publish via GitHub Release

**Publishing is fully automated via GitHub workflows!**

1. **Create a GitHub Release:**
   - Go to the GitHub repository
   - Click "Releases" → "Create a new release"
   - Set the tag to match your version:
     - Independent: `@datadog/openfeature-node-server@1.3.0` (publishes only that package)
     - Unified: `v1.2.1` (publishes all packages)
   - Add release notes describing your changes or use the `Generate Release Notes` button
   - Click "Publish release"

2. **Automated Publishing Workflow:**

   The `release.yaml` workflow will automatically trigger and:

   **Validation Phase:**
   - Checks that the GitHub release tag matches the corresponding package version
   - Fails fast if validation doesn't pass

   **Build and Publish Phase:**
   - Installs dependencies with `yarn install --immutable`
   - Builds all packages in release mode (`BUILD_MODE=release`)
   - Creates package tarballs with `yarn lerna run pack --stream`

   **Publishing Sequence:**

   *For independent releases* (`@datadog/pkg@x.y.z`):
   - Publishes only the specified package
   - If publishing `browser` or `node-server`, waits for `flagging-core` to be available on npm first

   *For unified releases* (`vX.Y.Z`):
   1. Publishes `@datadog/flagging-core` first
   2. Waits for npm registry propagation (up to 5 minutes)
   3. Publishes `@datadog/openfeature-browser`
   4. Publishes `@datadog/openfeature-node-server`

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

### Version Management

Since this project uses **independent versioning**:

- Each package has its own version number (stored in its `package.json`)
- `yarn release` prompts for version updates only for **changed** packages (independent releases)
- `yarn release:all` prompts for **all** packages (unified releases)
- Internal dependencies are pinned to exact versions (configured via `command.version.exact` in `lerna.json`)
- Version commits and tags are created per package (e.g., `@datadog/openfeature-node-server@1.3.0`)

> ⚠️ **Warning:** `@datadog/flagging-core` cannot be safely updated within the 1.x range. Users on `openfeature-node-server@1.2.1` have a `^1.2.1` constraint and would pull any new 1.x version, causing version skew. A major bump to `2.0.0` is required for any future `flagging-core` changes.

### Automated Release Workflow Details

The GitHub Actions workflow (`release.yaml`) includes several safety measures:

1. **Version Consistency Check:**
   - Compares GitHub release tag with the corresponding package version
   - Ensures tags and package versions are synchronized

2. **Dependency Coordination:**
   - Core package is published first
   - Waits for npm registry propagation (up to 5 minutes)
   - Browser package gets updated core dependency automatically

3. **Build Integrity:**
   - Uses `BUILD_MODE=release` for production builds
   - Replaces build environment variables correctly
   - Creates both npm packages and CDN bundles

### Testing Before Release

1. **Run all tests:**

   ```bash
   yarn test
   ```

2. **Type checking:**

   ```bash
   yarn typecheck
   ```

3. **Linting:**

   ```bash
   yarn lint
   ```

4. **Build verification:**

   ```bash
   yarn clean
   yarn build
   yarn build:bundle
   ```

5. **Package creation test:**
   ```bash
   yarn version  # Pins internal dependencies and creates package tarballs
   ```

### Troubleshooting

#### Common Issues

1. **Release from main branch:**
   - Error: "please do not release from `main` branch"
   - Solution: Create a feature branch for releases

2. **Version mismatch in GitHub workflow:**
   - Error: "Release tag doesn't match lerna.json version"
   - Solution: Ensure the GitHub release tag exactly matches `v{version}` format where `{version}` is from `lerna.json`

3. **Build environment issues:**
   - Ensure `BUILD_MODE` and `SDK_SETUP` are set correctly
   - Check that all dependencies are installed

4. **Version synchronization issues:**
   - Run `yarn node ./scripts/release/update-peer-dependency-versions.js` to pin internal dependencies
   - Verify internal dependencies use exact versions (no `^` prefix)

5. **GitHub workflow failures:**
   - Check the Actions tab for detailed error logs
   - Ensure GitHub secrets are properly configured:
     - `NPM_PUBLISH_TOKEN_FLAGGING_CORE` for core package
     - `NPM_PUBLISH_TOKEN` for browser package
   - Verify the release tag matches the version in `lerna.json`

6. **npm registry propagation delays:**
   - The workflow waits up to 5 minutes for the core package to be available
   - If this fails, it may indicate npm registry issues
   - Check npm status page or try republishing manually

7. **Webpack build issues:**
   - Ensure all TypeScript configurations are valid
   - Check that webpack configurations in each package are correct
   - Verify all required dependencies are installed

#### Getting Help

- Check the [README.md](README.md) for basic project information
- Review the scripts in the `scripts/` directory for implementation details
- Check the GitHub Actions tab for workflow status and logs
- Examine the `scripts/cli` script for available commands (`release`, `release_all`, `version`, `typecheck`, `lint`)
- Open an issue on GitHub for bugs or feature requests

#### Manual Publishing (Emergency Only)

If the automated workflow fails and you need to publish manually:

1. **Build packages:**

   ```bash
   BUILD_MODE=release yarn build
   yarn version
   ```

2. **Publish core package:**

   ```bash
   cd packages/core
   npm publish --tag latest
   ```

3. **Wait for propagation, then publish remaining packages:**
   ```bash
   cd packages/browser
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
