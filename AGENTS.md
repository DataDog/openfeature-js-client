# openfeature-js-client

Monorepo using **Lerna** with **independent versioning** — each package has its own version in its `package.json`.

## Release

See [CONTRIBUTING.md](CONTRIBUTING.md#creating-a-release) for the full release process.

Key commands:

```bash
# Interactive version bump (prompts per changed package)
yarn release

# Non-interactive version bump for a specific package
yarn lerna version <VERSION> --exact --yes --scope=@datadog/openfeature-browser
```

### Tag naming convention

```
core-v{version}        → publishes @datadog/flagging-core
browser-v{version}     → publishes @datadog/openfeature-browser
node-server-v{version} → publishes @datadog/openfeature-node-server
```

## Packages

- `@datadog/flagging-core` — runtime-agnostic flag evaluation (`packages/core/`)
- `@datadog/openfeature-browser` — browser OpenFeature provider (`packages/browser/`)
- `@datadog/openfeature-node-server` — Node.js OpenFeature provider (`packages/node-server/`)
