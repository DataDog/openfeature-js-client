# Compatibility

## OpenFeature SDK Version Support

This package supports `@openfeature/server-sdk` versions `>=1.15.0 <2.0.0`.

### Version Requirements

| @openfeature/server-sdk | @openfeature/core | Notes                     |
| ----------------------- | ----------------- | ------------------------- |
| 1.15.0+                 | 1.3.0+            | Minimum supported version |
| 1.17.0+                 | ^1.6.0+           | Current recommended       |

### Why 1.15.0 Minimum?

The provider interface requires features introduced in `@openfeature/server-sdk@1.15.0`. Earlier versions may produce warnings or fail tests.

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
