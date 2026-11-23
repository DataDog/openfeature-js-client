# Contributing to OpenFeature JS Client

Thank you for your interest in contributing to the OpenFeature JS Client! This document provides guidelines for contributing to the project, with a focus on the release process.

## Project Structure

This is a Yarn workspaces monorepo that contains multiple packages:

- **`@datadog/flagging-core`** - Runtime-agnostic flag-evaluation logic
- **`@datadog/openfeature-browser`** - Browser-specific bindings for OpenFeature
- **`@datadog/openfeature-node-server`** - Node.js server bindings for OpenFeature

The project uses **independent versioning**, meaning each package can have its own version number. Internal dependencies (e.g., `@datadog/flagging-core`) are pinned to exact versions on release to prevent version skew.

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

## Manual React Native Example

Run `yarn example:react-native` to build and pack the local core package and prepare
an isolated Expo app. The same command reuses a per-checkout cache directory outside
the repository and reinstalls a fresh core tarball on every run. Stop Metro before
refreshing, then follow the printed `cd` / `npm start` commands to launch Expo Go
on an iOS/Android simulator or device. The app verifies evaluation on Hermes and
supports exports-enabled, legacy CommonJS, and legacy ESM Metro modes.

See [the manual app README](test-app-react-native/manual/README.md) for prerequisites,
expected results, and how to rebuild after SDK changes. Unlike the automated
`yarn test:react-native-install` smoke test, this runs the code in a native JS runtime,
not Node.

## Entrypoint Guardrails

The default `@datadog/flagging-core` and `@datadog/openfeature-browser` entrypoints are expected to stay optimized for precomputed configurations. Rules-based parsing and its Protobuf-ES dependency must remain behind the `./rules-based` entrypoints.

For a new core subpath, add its source module and `package.json.exports` mapping, then run the
normal core build. Compatibility manifests, declaration mappings, publish-file lists, bundles,
and smoke-test imports are derived automatically. See [Adding a public entry point](packages/core/README.md#adding-a-public-entry-point).
Commit the generated metadata; `yarn check:entrypoints` rejects drift before CI builds or packing.

Recurring checks keep these contracts visible:

- `yarn test:build` checks generated entrypoint metadata and tests the generator, including adding a second/nested export without bundler registration.
- `yarn test:react-native-install` discovers every packed JavaScript subpath and checks modern and legacy resolution in the Metro matrix.

- `packages/core/test/entrypoint-boundaries.spec.ts` walks runtime imports from the default core/browser source entrypoints and fails if they reach generated protobuf code, Protobuf-ES, or rules-only parser modules.
- `yarn test:browser-install` builds the packed browser smoke app and runs `scripts/report-entrypoint-bundle-sizes.js`. The report compares `DatadogProvider` (precomputed fetching) with `DatadogCoreProvider` plus `fetchRulesConfiguration` (local rules evaluation), using the same OpenFeature initialization, boolean evaluation, and context-change flow with telemetry disabled for both. Playwright supplies configuration responses outside the measured bundles. These are complete scenario JS sizes, including OpenFeature and the shared harness, not isolated SDK or decoder sizes. Additional parser/fetch-wrapper smoke scenarios remain part of the dependency checks, summarized as a pass/fail result rather than a size table. Tracking-hook sizes are reported separately. In GitHub Actions the report is also appended to the step summary, pull request CI updates a sticky comment with the same report, and the script fails if default/precomputed bundles contain protobuf markers or rules-based bundles lack them.
- `yarn test:node-install` builds independent Webpack production bundles from the installed tarballs for the Node provider, SSR helpers (fetch client rules and serialize), precomputation from already-parsed rules, and the provider combined with each helper scenario. `scripts/report-node-entrypoint-bundle-sizes.js` reports raw/gzip JS sizes and the same-build cost of adding SSR helpers or precomputation to the provider. It selects the ESM `module` export condition, bundles dependencies except Node built-ins, and checks Webpack module statistics to ensure that only SSR bundles include Protobuf runtime or generated schema modules. The precompute-only and provider-plus-precompute bundles must remain Protobuf-free. The bundled functions are tested with fixture responses; the fixtures and precompute input parsing are outside the measured bundles. OpenFeature and dd-trace are not included. These are bundler scenario sizes, not npm install sizes, unbundled Node import costs, payload sizes, latency, or a direct comparison with the browser scenarios. To regenerate the report after installation, run `node scripts/report-node-entrypoint-bundle-sizes.js` and `node --test test-app-node/bundle.test.cjs`.

The sticky PR comment combines browser and Node reports after package-install checks. If only one report was generated, it identifies the missing report. The comment is only created or updated when the PR changes a bundle-relevant path. The allowlist in `scripts/comment-entrypoint-bundle-sizes.js` covers `packages/browser/**`, `packages/core/**`, `packages/node-server/**`, `test-app/**`, `test-app-node/**`, `scripts/build/**`, `scripts/lib/**`, the package-install/report/webpack-runner scripts, root dependency and build configuration, `.yarn/**`, and `.github/workflows/ci.yaml`. Markdown files are excluded. The filter checks the full PR diff, including deletions and both paths of renames, and publishes conservatively if GitHub's 3,000-file listing limit is reached. Report generation, the CI summary, smoke tests, and dependency checks still run regardless of the changed paths. `yarn test:build` covers the reports, filter, and comment creation/update behavior with mocked GitHub responses.

## Assignment authorization browser validation

`yarn test:browser-install` also runs `test-app/tests/assignment-authorization.spec.ts`
against the packed SDK in Chromium. These tests start a real local HTTP server on a
second origin, exercising CORS preflights and readable/unreadable error responses
without Playwright network interception. They cover no-token evaluations, ordinary
fetch failures, token refresh/removal, authorization rejection and recovery, and
credential exclusion from request bodies, telemetry, logs, and browser storage.

After packaging, rerun only these scenarios with:

```bash
cd test-app
yarn test:browser assignment-authorization
```

The endpoint returns controlled responses; these tests do not verify JWT signatures,
Fastly deployment configuration, or public-key rotation. Live integration validation
must additionally confirm that Fastly allows `DD-Assignment-Token` in CORS and includes
CORS response headers on authorization errors.

## Release Process

A release has three parts:

1. A release PR changes the package versions and the CHANGELOG.
2. After the PR merges, a GitHub Release creates the version tag on `main`.
3. The published GitHub Release starts the `release.yaml` workflow, which builds and publishes the package to npm.

You do not create or push tags by hand. The GitHub Release creates the tag.

### Build Modes

The project supports different build modes that affect how the SDK version is determined:

#### 1. Development Mode (`dev`)

- **Default mode** when `BUILD_MODE` is not set
- SDK version is set to `"dev"`
- Used during development and testing

#### 2. Release Mode (`release`)

- Used for public releases
- SDK version uses the version from the package's `package.json`
- This is the mode used for production releases

#### 3. Canary Mode (`canary`)

- Used on staging and production Datadog web app
- SDK version format: `{package-version}-{commit-sha}`
- Example: `0.1.0-alpha.2-a1b2c3d4`

Run builds through `yarn build`, `yarn workspace <package-name> build`, or from the package directory. The build scripts read `package.json` from their working directory; release and canary builds fail if the package version cannot be read. Development builds continue to use `dev`.

`yarn test:build` verifies package-specific version stamping and runs in regular CI.

The publishing job sets `BUILD_MODE=release` for all steps, including the `prepack` rebuilds triggered by packing and publishing. CI also runs the packed-browser smoke test in release mode and verifies that configuration requests report the installed package's version.

### SDK Setups

The project also supports different SDK setups:

- **`npm`** (default) - For npm package distribution
- **`cdn`** - For CDN distribution

### Creating a Release

All packages are published with the `latest` npm tag, unless the GitHub Release is marked as a pre-release (see [Pre-releases](#pre-releases)).

#### Step 1: Create a Release Branch

Create a branch from an up-to-date `main`. Name it for the packages that you release:

```bash
git fetch origin
git checkout -b release/browser-2.4.0-core-3.6.0 origin/main
```

#### Step 2: Set the Package Versions

1. Decide which packages to release. Compare each package with its last release tag:

   ```bash
   git log --oneline @datadog/openfeature-browser@2.3.0..origin/main -- packages/browser
   ```

   If a dependent package (`browser` or `node-server`) uses core code that is not in the published `@datadog/flagging-core`, release core too.

2. Edit the `version` field in the `package.json` of each package that you release. Use semver: patch for fixes, minor for backward-compatible features, major for breaking changes.

3. Pin the internal dependencies to the new versions:

   ```bash
   yarn node ./scripts/release/update-peer-dependency-versions.js
   ```

   This script reads each package's current version. It sets internal dependencies (such as `@datadog/flagging-core`) to exact versions with no `^` prefix. This prevents version skew between packages. It also changes the pin in packages that you do not release. That is correct: the next release of those packages uses the same core.

4. Update the lockfile:

   ```bash
   yarn install
   ```

5. Check the result:

   ```bash
   git diff packages/*/package.json yarn.lock
   bash scripts/internal-deps-validate.sh
   ```

#### Step 3: Update the CHANGELOG

Replace the `## Unreleased` heading in `CHANGELOG.md` with a heading that names each released package and version, for example `## @datadog/openfeature-browser@2.4.0, @datadog/flagging-core@3.6.0`.

Make sure that the section lists every user-facing change since the last release of each package. Tag each entry with `[CORE]`, `[BROWSER]` or `[NODE-SERVER]`. Put behavior changes under **Usage Notes**.

#### Step 4: Validate the Release Branch

Run the checks in release mode:

```bash
export BUILD_MODE=release
yarn build
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn test:browser-install
```

`yarn test:browser-install` packs the packages and runs the packed browser SDK in Chromium. The release workflow runs the same test.

#### Step 5: Open and Merge the Release PR

1. Open a PR from the release branch to `main`. List each release tag in the PR description.
2. Get approval and make sure that CI passes.
3. Merge the PR.

Do not create a GitHub Release before the PR merges. The tag must point to a commit on `main`.

#### Step 6: Publish with a GitHub Release

Create one GitHub Release for each package. If core is in the release, publish core first.

1. Go to **Releases** → **Draft a new release**.
2. In **Choose a tag**, type the new tag name. Select **Create new tag on publish**.
   - Independent release: `@datadog/<package-name>@<version>`, for example `@datadog/openfeature-browser@2.4.0`. This publishes only that package.
   - Unified release: `v<version>`, for example `v1.2.1`. This publishes all packages. Every package must have this version.
3. Set **Target** to `main`. If `main` has new commits after the release PR, set the target to the merge commit of the release PR.
4. Set the release title to the tag name.
5. Paste the CHANGELOG entries for the package into the release notes.
6. Click **Publish release**.

You can also use the GitHub CLI. With `--target`, `gh` creates the tag on publish:

```bash
gh release create '@datadog/flagging-core@3.6.0' \
  --repo DataDog/openfeature-js-client \
  --target <release-pr-merge-commit-sha> \
  --title '@datadog/flagging-core@3.6.0' \
  --notes-file core-release-notes.md
```

When the release is published, GitHub creates the tag and the `release.yaml` workflow starts.

#### Step 7: Approve and Verify the Publication

1. Open the `Publish packages on NPM` run in the **Actions** tab.
2. Both jobs use the `production` environment. Approve the deployment when GitHub asks for it.
3. When the run completes, make sure that npm has the new version:

   ```bash
   npm view @datadog/flagging-core@3.6.0 version
   ```

4. For a browser or Node.js release in the same batch, create its GitHub Release only after npm has the new core version. The workflow waits up to 5 minutes for core and then fails.

#### Pre-releases

Select **Set as a pre-release** on the GitHub Release to publish a pre-release:

- A tag that contains `preview` publishes with the `preview` npm tag.
- Any other pre-release tag publishes with the `alpha` npm tag.

### What the Release Workflow Does

The `release.yaml` workflow runs when a GitHub Release is published.

**Validation job (`validate-release`):**

- Reads the package name and version from the release tag.
- Fails if the version in the package's `package.json` is different from the tag version.
- Fails if an internal dependency does not use an exact version (`scripts/internal-deps-validate.sh`).

**Build and publish job (`build-and-publish`):**

- Installs dependencies with `yarn install --immutable`.
- Builds all packages with `BUILD_MODE=release`.
- Packs each package and runs `yarn test:browser-install`.
- Publishes with npm provenance through npm trusted publishing (OIDC). The workflow needs no npm token secret. See [the OIDC migration notes](docs/npm-oidc-migration.md).
- Skips a package version that npm already has.

**Publication order:**

- Independent release (`@datadog/<package-name>@x.y.z`): publishes only that package. For `browser` and `node-server`, it first waits until npm has the pinned `flagging-core` version.
- Unified release (`vX.Y.Z`): publishes `@datadog/flagging-core`, waits until npm has it, and then publishes `@datadog/openfeature-browser` and `@datadog/openfeature-node-server`.

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

- Each package has its own version number in its `package.json`.
- You set the versions by hand in the release PR.
- Internal dependencies are pinned to exact versions. `scripts/internal-deps-validate.sh` enforces this in the release workflow.
- Each package has its own release tag, for example `@datadog/openfeature-node-server@1.3.0`. The GitHub Release creates the tag.

> ⚠️ **Version policy for `@datadog/flagging-core`:** Internal dependencies are pinned to **exact** versions (enforced by `scripts/internal-deps-validate.sh`), so our packages never pull a core update implicitly. From `2.0.0` onward, `flagging-core` follows normal semver — minor/patch for backward-compatible changes, major for breaking ones. Two rules still apply:
>
> 1. **Do not publish new `1.x` versions of `flagging-core`.** Legacy consumers still on `^1.2.1` would pull them and risk version skew; the `2.0.0` major bump exists to cap those consumers below `2.x`.
> 2. **Bumping core does not reach dependents automatically.** Because `openfeature-browser` and `openfeature-node-server` pin core exactly, you must update each dependent's pin and re-release it (see [Step 2](#step-2-set-the-package-versions)) for consumers to pick up the new core.

### Troubleshooting

#### Common Issues

1. **The workflow did not start:**
   - The workflow starts only when a GitHub Release is **published**. A draft release or a pushed tag does not start it.

2. **Version mismatch in the validation job:**
   - Error: `Release tag version X doesn't match packages/<dir> version Y`
   - Cause: the tag points to a commit where the package has a different version. This occurs when the release is created before the release PR merges, or when the target is wrong.
   - Solution: delete the GitHub Release and its tag. Then create the release again with the release PR merge commit as the target.

3. **Internal dependency validation fails:**
   - Run `yarn node ./scripts/release/update-peer-dependency-versions.js`.
   - Make sure that internal dependencies use exact versions with no `^` prefix.

4. **The workflow waits for the production approval:**
   - Both jobs use the `production` environment. An approver must approve each job in the Actions run.

5. **Timeout while the workflow waits for core:**
   - The workflow waits up to 5 minutes for the pinned `@datadog/flagging-core` version on npm.
   - Make sure that the core release completed first. Then re-run the failed job.

6. **Build environment issues:**
   - Ensure `BUILD_MODE` and `SDK_SETUP` are set correctly
   - Check that all dependencies are installed

7. **Webpack build issues:**
   - Ensure all TypeScript configurations are valid
   - Check that webpack configurations in each package are correct
   - Verify all required dependencies are installed

#### Getting Help

- Check the [README.md](README.md) for basic project information
- Review the scripts in the `scripts/` directory for implementation details
- Check the GitHub Actions tab for workflow status and logs
- Open an issue on GitHub for bugs or feature requests

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
