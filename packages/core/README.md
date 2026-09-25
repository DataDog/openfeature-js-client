# Datadog OpenFeature Core Library

## Configuration parsing entry points

The default `@datadog/flagging-core` entry point parses precomputed configuration without
loading the protobuf decoder. To parse both precomputed and rules-based configuration,
opt into the full parser:

```ts
import { configurationFromString, configurationToString } from '@datadog/flagging-core/rules-based'
```

The `/rules-based` entry point is available through both the package's `exports` map and a
physical `rules-based/package.json` for resolvers that do not support package exports. Both
paths point to the same implementation; the default entry point and its dependency boundary
are unchanged. This fallback only addresses resolution of this package's entry point:
legacy bundlers must also be able to resolve the subpaths used by its protobuf dependency.

## End-user license agreement

https://www.datadoghq.com/legal/eula
