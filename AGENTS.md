# openfeature-js-client

Yarn workspaces monorepo with **independent versioning**. Each package declares its version in its own `package.json`.

## Release

See [CONTRIBUTING.md](CONTRIBUTING.md#creating-a-release) for the full release process.

Prepare only the requested package releases and their required dependencies. Keep internal dependencies pinned to exact versions.

A release PR sets package versions by hand and updates `CHANGELOG.md`. Do not create or push release tags. After the release PR merges, a GitHub Release creates the tag on `main`. Publishing that GitHub Release triggers npm publication for the package named in its tag. Do not create a GitHub Release when the user requests preparation only.

## Packages

- `@datadog/flagging-core` — runtime-agnostic flag evaluation (`packages/core/`)
- `@datadog/openfeature-browser` — browser OpenFeature provider (`packages/browser/`)
- `@datadog/openfeature-node-server` — Node.js OpenFeature provider (`packages/node-server/`)
