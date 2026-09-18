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

Install the OpenFeature SDK if your application uses this package as an OpenFeature provider:

```bash
npm install @openfeature/server-sdk @openfeature/core
# or
yarn add @openfeature/server-sdk @openfeature/core
```

`@datadog/openfeature-node-server` does not install either OpenFeature package as a runtime dependency.

### For dd-trace Users

If you're using `dd-trace` and don't need OpenFeature functionality directly, you don't need to install these packages.
