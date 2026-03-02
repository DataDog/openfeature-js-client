# Release Guide — openfeature-js-client

This monorepo uses **Lerna** with **fixed versioning** — all packages (`@datadog/flagging-core`, `@datadog/openfeature-browser`, `@datadog/openfeature-node-server`) share the same version defined in `lerna.json`.

## Making a Release

### 1. Create a release branch from main

```bash
git checkout main
git pull origin main
git checkout -b release/v<VERSION>
git push -u origin release/v<VERSION>
```

The branch **must** be pushed to the remote before running lerna (lerna requires the branch to exist on origin).

### 2. Bump version with Lerna

```bash
# Interactive — lerna prompts you to pick/enter the version
yarn release

# Non-interactive — specify version directly
yarn lerna version <VERSION> --exact --force-publish --yes
```

This does the following:

- Updates `lerna.json` version
- Updates all `package.json` files to the new version
- Runs the `version` lifecycle script which:
  - Generates CHANGELOG.md entries from git history
  - Updates peer dependency versions across packages
  - Runs `lerna pack` to create tarballs
- Creates a git commit (`v<VERSION>`) and tag (`v<VERSION>`)
- Pushes the tag to origin

### 3. Push the release branch and open a PR

```bash
git push origin release/v<VERSION>
gh pr create --draft --title "Release v<VERSION>"
```

### 4. Publish via GitHub Release

After the PR is merged to main:

1. Go to **GitHub Releases** → **Create a new release**
2. Set the tag to `v<VERSION>` (must match `lerna.json`)
3. For prereleases (alpha/preview), check "This is a pre-release"
4. Click **Publish release**

The `release.yaml` workflow handles everything:

- Validates tag matches `lerna.json`
- Builds in release mode (`BUILD_MODE=release`)
- Publishes `@datadog/flagging-core` first
- Waits for npm propagation (up to 5 min)
- Publishes `@datadog/openfeature-browser`
- Publishes `@datadog/openfeature-node-server`

### NPM tag mapping

| Release type     | Example tag        | npm tag   |
| ---------------- | ------------------ | --------- |
| Production       | `v1.1.0`           | `latest`  |
| Preview          | `v2.0.0-preview.1` | `preview` |
| Other prerelease | `v2.0.0-alpha.1`   | `alpha`   |

## Version Types

| Type       | Lerna flag                    | Example                           |
| ---------- | ----------------------------- | --------------------------------- |
| Patch      | `--patch` or explicit `1.0.1` | Bug fixes only                    |
| Minor      | `--minor` or explicit `1.1.0` | New features, backward-compatible |
| Major      | `--major` or explicit `2.0.0` | Breaking changes                  |
| Prerelease | explicit `2.0.0-alpha.1`      | Pre-production testing            |

## Pre-release Checklist

```bash
yarn test        # All tests pass
yarn typecheck   # No type errors
yarn lint        # No lint issues
yarn build       # Clean build
```

## Troubleshooting

- **"please do not release from main branch"** — create a `release/v*` branch first
- **"ENOREMOTEBRANCH"** — push the branch to origin before running lerna version
- **"Release tag doesn't match lerna.json"** — the GitHub Release tag must be exactly `v<VERSION>` matching `lerna.json`
- **npm propagation timeout** — the workflow retries for 5 min; if it fails, check npm status or re-run the workflow
