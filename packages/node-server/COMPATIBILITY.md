# Compatibility

## OpenFeature SDK Version Support

This package supports `@openfeature/server-sdk` versions `>=1.11.0 <2.0.0`.

### Version Requirements

| @openfeature/server-sdk | @openfeature/core | Notes |
|-------------------------|-------------------|-------|
| 1.11.0 - 1.13.x | 0.0.25 - 0.0.27 | Minimum supported version |
| 1.14.0+ | 1.2.0+ | Core package moved to 1.x |
| 1.17.0+ | ^1.6.0+ | Current recommended |

### Why 1.11.0 Minimum?

The `ProviderEventEmitter` export, which this package uses, was introduced in `@openfeature/server-sdk@1.11.0`. Earlier versions do not export this type and will fail to compile.

### Installation

For most users, install the latest versions:

```bash
npm install @openfeature/server-sdk @openfeature/core
# or
yarn add @openfeature/server-sdk @openfeature/core
```

The packages will resolve compatible versions automatically.

### For dd-trace Users

If you're using `dd-trace` and don't need OpenFeature functionality directly, you don't need to install these packages. The `@datadog/openfeature-node-server` peer dependency is optional.
