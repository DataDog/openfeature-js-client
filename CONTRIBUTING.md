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

#### Step 1: Prepare for Release

1. **Switch to a feature branch:**
   ```bash
   git checkout -b release/v1.2.3
   ```

2. **Update the version:**
   ```bash
   yarn release
   ```
   
   This command:
   - Runs `lerna version --exact --force-publish` to update the version
   - Prompts for the new version number (applied to all packages)
   - Creates version commits and tags
   - Updates all package versions to match

#### Step 2: Build for Release

1. **Build all packages in release mode:**
   ```bash
   BUILD_MODE=release yarn build
   ```

2. **Build browser bundle for CDN:**
   ```bash
   BUILD_MODE=release SDK_SETUP=cdn yarn build:bundle
   ```

3. **Create packages for distribution:**
   ```bash
   yarn version
   ```
   
   This command:
   - Generates a unified changelog for the entire project
   - Updates peer dependency versions to match the fixed version
   - Runs `lerna run pack` to create tarballs
   - Updates test app lockfiles

#### Step 3: Publish via GitHub Release

**Publishing is now automated via GitHub workflows!**

1. **Create a GitHub Release:**
   - Go to the GitHub repository
   - Click "Releases" → "Create a new release"
   - Set the tag to match your version (e.g., `v1.2.3`)
   - Mark as "This is a pre-release" for alpha/beta versions
   - Add release notes describing your changes
   - Click "Publish release"

2. **Automated Publishing:**
   - The `prerelease.yaml` workflow will automatically trigger
   - Validates the release type and version consistency
   - Builds all packages in release mode
   - Publishes packages to npm with appropriate tags
   - Updates the GitHub release with build information

### Package-Specific Build Commands

#### Core Package (`@datadog/flagging-core`)

```bash
# Build CommonJS and ESM modules
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

### TODO Unified Changelog

~~The project uses a unified changelog system:~~

- ~~All changes across all packages are documented in a single `CHANGELOG.md` file~~
- ~~The changelog is generated automatically during the release process~~
- ~~Changes are categorized and organized by type~~
- ~~The changelog follows a consistent format for all releases~~

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

### Troubleshooting

#### Common Issues

1. **Release from main branch:**
   - Error: "please do not release from `main` branch"
   - Solution: Create a feature branch for releases

2. **Build environment issues:**
   - Ensure `BUILD_MODE` and `SDK_SETUP` are set correctly
   - Check that all dependencies are installed

3. **Version synchronization issues:**
   - Run `yarn version` to update peer dependencies
   - Check that all package versions match the version in `lerna.json`

4. **GitHub workflow failures:**
   - Check the Actions tab for detailed error logs
   - Ensure GitHub secrets are properly configured
   - Verify the release tag matches the version in `lerna.json`

#### Getting Help

- Check the [README.md](README.md) for basic project information
- Review the scripts in the `scripts/` directory for implementation details
- Check the GitHub Actions tab for workflow status and logs
- Open an issue on GitHub for bugs or feature requests

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