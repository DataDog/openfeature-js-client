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

#### NPM Tag Conventions

The release workflow automatically determines the npm tag based on your release tag name:

- **`alpha` tag**: Used for all prerelease versions that don't contain "preview"
  - Example release tags: `v0.1.0-alpha.13`, `v0.2.0-beta.1`, `v1.0.0-rc.1`
  - npm install: `npm install @datadog/flagging-core@alpha`

- **`preview` tag**: Used for prerelease versions that contain "preview" in the tag
  - Example release tags: `v0.1.0-preview.1`, `v0.2.0-preview.2`
  - npm install: `npm install @datadog/flagging-core@preview`

Both packages (core and browser) will be published with the same npm tag to maintain consistency.

#### Step 1: Prepare for Release

1. **Switch to a feature branch:**
   ```bash
   git checkout -b release/v1.2.3
   ```

#### Step 2: Prepare Package Dependencies

2. **Update the version using the CLI:**

   ```bash
   yarn release
   ```

   This command:
   - Validates you're not on the `main` branch
   - Runs `lerna version --exact --force-publish` to update the version
   - Prompts for the new version number (applied to all packages)
   - Creates version commits and tags
   - Updates all package versions to match
   - Pushes version tag to Github

#### Step 3: Publish via GitHub Release

**Publishing is fully automated via GitHub workflows!**

1. **Create a GitHub Release:**
   - Go to the GitHub repository
   - Click "Releases" → "Create a new release"
   - Set the tag to match your version (e.g., `v0.1.0-alpha.8`)
   - **Important:** Mark as "This is a pre-release" for alpha/beta versions
   - Add release notes describing your changes or use the `Generate Release Notes` button
   - Click "Publish release"

2. **Automated Publishing Workflow:**

   The `prerelease.yaml` workflow will automatically trigger and:

   **Validation Phase:**
   - Validates that the release is marked as a prerelease
   - Checks that the GitHub release tag matches the version in `lerna.json`
   - Fails fast if validation doesn't pass

   **Build and Publish Phase:**
   - Installs dependencies with `yarn install --frozen-lockfile`
   - Builds all packages in release mode (`BUILD_MODE=release`)
   - Creates package tarballs with `yarn lerna run pack --stream`

   **Publishing Sequence:**
   1. **Determines npm tag** based on release tag:
      - If release tag contains "preview" → uses `preview` npm tag
      - Otherwise → uses `alpha` npm tag (default)
   2. **Publishes core package first** (`@datadog/flagging-core`)
      - Uses `NPM_PUBLISH_TOKEN_FLAGGING_CORE` secret
      - Publishes with the determined npm tag (`alpha` or `preview`)
   3. **Waits for npm registry propagation**
      - Polls npm registry for up to 5 minutes
      - Ensures core package is available before proceeding
      - Prevents dependency resolution issues
   4. **Publishes browser package** (`@datadog/openfeature-browser`)
      - Uses `NPM_PUBLISH_TOKEN` secret
      - Publishes with the same npm tag as core package
      - Will have updated dependency on the just-published core package

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

Since this project uses **fixed versioning**:

- All packages share the same version number (managed in `lerna.json`)
- When running `yarn release`, Lerna will prompt for a single version update
- All package versions are automatically synchronized
- Peer dependencies are automatically updated to match the fixed version
- A single version commit and tag is created for the entire project

### Automated Release Workflow Details

The GitHub Actions workflow (`prerelease.yaml`) includes several safety measures:

1. **Release Type Validation:**
   - Only triggers on prerelease GitHub releases
   - Prevents accidental production releases without proper workflow

2. **Version Consistency Check:**
   - Compares GitHub release tag with `lerna.json` version
   - Ensures tags and versions are synchronized

3. **Dependency Coordination:**
   - Core package is published first
   - Waits for npm registry propagation (up to 5 minutes)
   - Browser package gets updated core dependency automatically

4. **Build Integrity:**
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
   yarn version  # Test dependency updates and package creation
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
   - Run `yarn version` to update peer dependencies
   - Check that all package versions match the version in `lerna.json`

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
- Examine the `scripts/cli` script for available commands (`release`, `version`, `typecheck`, `lint`)
- Open an issue on GitHub for bugs or feature requests

#### Manual Publishing (Emergency Only)

If the automated workflow fails and you need to publish manually:

1. **Build packages:**

   ```bash
   BUILD_MODE=release yarn build
   yarn version
   ```

2. **Determine npm tag** based on your version:
   - For versions containing "preview": use `preview` tag
   - For other prerelease versions: use `alpha` tag

3. **Publish core package:**

   ```bash
   cd packages/core
   npm publish --tag alpha  # or --tag preview
   ```

4. **Wait for propagation, then publish browser package:**
   ```bash
   cd packages/browser
   npm publish --tag alpha  # or --tag preview (same as core)
   ```

## Licensing

Ensure license information for newly added third party packages are included in LICENSE-3rdparty.csv. For Datadog employees, this can be done automatically with `yarn licenses:generate`.

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
