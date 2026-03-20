# NPM Trusted Publishing (OIDC) Migration Plan

**Date:** 2026-03-02
**Context:** [incident-44653 - NPM account restrictions](https://datadoghq.atlassian.net/wiki/spaces/SECENG/pages/5629543176)
**Repo:** `DataDog/openfeature-js-client`

## Motivation

GitHub/NPM is deprecating classic access tokens and restricting granular token lifetimes.
Our release workflow currently authenticates to NPM using the `ENV_NPM_TOKEN` secret
(written to `~/.npmrc` at publish time). We need to migrate to **OIDC trusted publishing**,
where GitHub Actions exchanges a short-lived OIDC token directly with NPM — no stored
secrets required.

## Current State

| Item | Value |
|------|-------|
| Packages | `@datadog/flagging-core`, `@datadog/openfeature-browser`, `@datadog/openfeature-node-server` |
| Auth method | `ENV_NPM_TOKEN` secret → `~/.npmrc` |
| Workflow | `.github/workflows/release.yaml` |
| GH environment | `production` |
| `id-token: write` | Already set (line 4) |
| Yarn version | 4.9.2 (needs bump to >=4.10.3) |
| Lerna version | ^9.0.3 (meets >=9.0.0 requirement) |

## What Changes

### 1. npmjs.com — Configure Trusted Publishers (manual, requires NPM account access)

For **each** of the 3 packages, on npmjs.com:

1. Log in to the `datadog` NPM account
   - If no access, request the `Shared-Robot-NPM-frontend` 1password vault via [FreshService ticket](https://datadog.freshservice.com/support/catalog/items/95)
2. Navigate to the package → **Settings** → **Trusted Publisher**
3. Select **GitHub Actions** and fill in:
   - **GitHub org:** `DataDog`
   - **Repo:** `openfeature-js-client`
   - **Workflow:** `release.yaml`
   - **Environment:** `production`
4. Save

Repeat for:
- `@datadog/flagging-core`
- `@datadog/openfeature-browser`
- `@datadog/openfeature-node-server`

### 2. Bump Yarn to >=4.10.3 (code change)

The Confluence guide says yarn must be >=4.10.3 for OIDC support. We're on 4.9.2.

```bash
yarn set version 4.10.3
```

This updates `.yarnrc.yml` and the `packageManager` field in `package.json`.

### 3. Update `release.yaml` — Remove token-based auth (code change)

**Remove** all lines that write `ENV_NPM_TOKEN` to `~/.npmrc` or set `NODE_AUTH_TOKEN`.

Specifically, in the "Publish core package first" step (lines 140-145):
```diff
-          echo "//registry.npmjs.org/:_authToken=${{ secrets.ENV_NPM_TOKEN }}" > ~/.npmrc
-          npm config set access public
+          npm config set //registry.npmjs.org/:_authToken "${NPM_TOKEN}"
```

Actually, with OIDC trusted publishing + `id-token: write` + the `production` environment already
configured, **npm publish will automatically use OIDC**. The changes are:

#### a) Remove `.npmrc` token injection (2 locations)

**"Publish core package first" step** — remove lines:
```yaml
echo "//registry.npmjs.org/:_authToken=${{ secrets.ENV_NPM_TOKEN }}" > ~/.npmrc
npm config set access public
```
and remove:
```yaml
env:
  NODE_AUTH_TOKEN: ${{ secrets.ENV_NPM_TOKEN }}
```

**"Publish tagged package" step** — same removals:
```yaml
echo "//registry.npmjs.org/:_authToken=${{ secrets.ENV_NPM_TOKEN }}" > ~/.npmrc
npm config set access public
```
and remove:
```yaml
env:
  NODE_AUTH_TOKEN: ${{ secrets.ENV_NPM_TOKEN }}
```

#### b) Add `--provenance` to npm publish commands (optional but recommended)

NPM provenance attestation is a bonus of OIDC — it lets consumers verify the package
was built from a specific commit. Since the Confluence doc says "if you already use npm
provenance, you can remove the `--provenance` arg" (it becomes automatic with trusted
publishing), we can optionally add `--provenance` for the transition period or leave it out.

#### c) Configure `setup-node` with registry-url

To ensure npm knows which registry to authenticate with via OIDC:
```yaml
- uses: actions/setup-node@6044e13b5dc448c55e2357c09f80417699197238
  with:
    node-version: '20.x'
    cache: 'yarn'
    registry-url: 'https://registry.npmjs.org'
```

### 4. Test the migration

1. Create a prerelease (e.g. `core-v1.1.1-oidc-test.1`) to verify OIDC publishing works
2. Check that the package appears on npmjs.com with the correct tag
3. If it fails, the `ENV_NPM_TOKEN` secret is still in the environment as a fallback

### 5. Post-migration cleanup (manual, on npmjs.com)

After a successful OIDC publish:

1. **Lock down packages**: For each package on npmjs.com → Settings → Publishing access →
   Select **"Require two-factor authentication and disallow tokens"** → Update
2. **Delete the old token**: Profile → Access tokens → find and delete the `ENV_NPM_TOKEN`
3. **Remove the secret from GitHub**: Repo → Settings → Environments → `production` → remove `ENV_NPM_TOKEN`

## Step-by-Step Implementation Order

| # | Action | Type | Risk |
|---|--------|------|------|
| 1 | Configure trusted publishers on npmjs.com (all 3 packages) | Manual/NPM | None — additive, doesn't break existing flow |
| 2 | Bump yarn to 4.10.3 | Code | Low — minor version bump |
| 3 | Update `release.yaml` to remove token auth | Code | Medium — publish will fail if OIDC not configured |
| 4 | Open PR, get review, merge | Code | Low |
| 5 | Test with a prerelease | Manual | Low — prerelease tag, easily reversible |
| 6 | Lock down package settings on npmjs.com | Manual | Low — do after confirming OIDC works |
| 7 | Delete old NPM token and GH secret | Manual | None — OIDC is working at this point |

## Files Changed

- `.github/workflows/release.yaml` — remove token auth, add registry-url to setup-node
- `package.json` — `packageManager` field bumped by yarn upgrade
- `.yarnrc.yml` — updated by yarn upgrade
- `yarn.lock` — updated by yarn upgrade
- `.yarn/releases/` — new yarn binary (if using checked-in releases)

## Rollback Plan

If OIDC publishing fails:
1. Re-add `ENV_NPM_TOKEN` secret to the `production` environment
2. Revert the `release.yaml` changes
3. The trusted publisher config on npmjs.com can stay — it doesn't interfere with token auth

## References

- [Confluence: incident-44653 migration guide](https://datadoghq.atlassian.net/wiki/spaces/SECENG/pages/5629543176)
- [NPM Trusted Publishers docs](https://docs.npmjs.com/trusted-publishers)
- [GitHub blog: NPM security changes](https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/)
- [Example: dd-native-appsec-js](https://github.com/DataDog/dd-native-appsec-js/blob/20471af20302063c0ac465ede00f1728dc7ebb64/.github/workflows/release.yml#L84-L85)
