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

## Adding a public entry point

`packages/core/package.json` **`exports` is the single source of truth** for public paths.
To add `@datadog/flagging-core/foo`:

1. Create `src/foo.ts` with the intended exports. Keep any required initialization in this
   source entry point, rather than adding it to a bundler-specific list.
2. Add its modern mapping to `exports`:

   ```json
   {
     "./foo": {
       "types": "./cjs/foo.d.ts",
       "import": "./esm/foo.js",
       "require": "./cjs/foo.js",
       "default": "./esm/foo.js"
     }
   }
   ```

3. Run `yarn workspace @datadog/flagging-core build` and commit the generated metadata with
   the source change. Add the feature's behavior tests as usual.

The build generates the physical fallback manifests, publish-file list, legacy declaration
mappings, and compatibility-bundle side-effect entries. It discovers and builds a CJS/ESM
compatibility bundle for every public JavaScript subpath automatically. Do not edit those
fallback manifests or register new paths in the Webpack configuration or smoke fixtures.

Concrete nested subpaths are supported; wildcard exports and mismatched CJS/ESM/type targets
fail with an actionable error. Removing a path from `exports` and rebuilding removes its
owned fallback manifest and derived metadata without deleting unrelated files.

`yarn check:entrypoints` checks generated metadata without changing files. CI runs it before
building, and `prepack` checks it before packing so a stale publish-file list cannot silently
omit a new entry point. The packed-package tests discover every declared path and generate
static imports for the full Metro matrix. The default entry point remains separate and light.

## End-user license agreement

https://www.datadoghq.com/legal/eula
