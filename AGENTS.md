# openfeature-js-client

Monorepo using **Lerna** with **independent versioning**. Each package declares its version in its own `package.json`.

## Release

See [CONTRIBUTING.md](CONTRIBUTING.md#creating-a-release) for the full release process.

Prepare only the requested package releases and their required dependencies. Keep internal dependencies pinned to exact versions.

`yarn release` creates commits and tags and pushes them. Do not run it when the user requests preparation only. Publishing a GitHub release triggers npm publication for the package named in its tag.

## Packages

- `@datadog/flagging-core` — runtime-agnostic flag evaluation (`packages/core/`)
- `@datadog/openfeature-browser` — browser OpenFeature provider (`packages/browser/`)
- `@datadog/openfeature-node-server` — Node.js OpenFeature provider (`packages/node-server/`)
