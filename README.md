# Datadog OpenFeature Javascript Clients

This repository hosts Browser and React Native clients.

It is currently in-development.

## Packages

This repository contains two packages:

- `@datadog/flagging-core`: Runtime-agnostic flag-evaluation logic for OpenFeature JS
- `@datadog/openfeature-browser`: Browser-specific bindings for OpenFeature (wraps @datadog/flagging-core)

## Release Process

Packages are published to npm using a tagging convention. When creating a GitHub release, use the format `<package name>@<semantic-version>`:

- `browser@0.1.0-alpha.2` - Publish the browser package
- `core@0.1.0-alpha.1` - Publish the core package

This follows the same pattern as the [Eppo multiplatform workflow](https://github.com/Eppo-exp/eppo-multiplatform/blob/main/.github/workflows/publish.yml).

## Integrating the pre-release packages

```
# Install browser package
npm install @datadog/openfeature-browser@alpha
# or
npm install @datadog/openfeature-browser@0.1.0-alpha.2

# Install core package
npm install @datadog/flagging-core@alpha
# or
npm install @datadog/flagging-core@0.1.0-alpha.1
```
