# openfeature-js-client

Monorepo using **Lerna** with **fixed versioning** — all packages share the version in `lerna.json`.

## Release

See [CONTRIBUTING.md](CONTRIBUTING.md#creating-a-release) for the full release process.

Key commands:

```bash
# Non-interactive version bump (use this instead of interactive `yarn release`)
yarn lerna version <VERSION> --exact --force-publish --yes
```

## Packages

- `@datadog/flagging-core` — runtime-agnostic flag evaluation (`packages/core/`)
- `@datadog/openfeature-browser` — browser OpenFeature provider (`packages/browser/`)
- `@datadog/openfeature-node-server` — Node.js OpenFeature provider (`packages/node-server/`)
