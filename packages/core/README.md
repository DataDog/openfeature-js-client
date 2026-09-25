# Datadog OpenFeature Core Library

## Configuration parsing entry points

The default `@datadog/flagging-core` entry point parses precomputed configuration without
loading the protobuf decoder. To parse both precomputed and rules-based configuration,
opt into the full parser:

```ts
import { configurationFromString, configurationToString } from '@datadog/flagging-core/rules-based'
```

The `/rules-based` entry point is available through both the package's `exports` map and a
physical `rules-based/package.json` for resolvers that do not support package exports:

- Modern resolvers use the existing modular CommonJS/ESM implementations.
- Legacy resolvers use self-contained CommonJS/ESM compatibility bundles generated from the
  same source during `yarn build` / package preparation. These include the required protobuf
  code, so consumers do not have to resolve its `/wire` or `/codegenv2` subpaths.
- Both paths expose the same API and reuse the same TypeScript declarations. The default
  entry point stays modular and does not import the compatibility bundles or protobuf decoder.

The compatibility bundles increase the npm package size, but only applications using the
legacy rules-based entry point include them in their application bundle. They retain dependency
copyright/license notices and source maps, and are left unminified for the application bundler
to optimize.

The packed-package smoke test covers Android and iOS bundles with Metro package exports both
enabled and disabled, including legacy CommonJS and ESM resolution. It executes those bundles
in Node without `BigInt`, `TextEncoder`, or `TextDecoder`; this checks fallback behavior but does
not replace execution tests on an actual Hermes or JavaScriptCore runtime.

## End-user license agreement

https://www.datadoghq.com/legal/eula
