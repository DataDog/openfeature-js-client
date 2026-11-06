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

## Local Precomputation

The `/rules-based` entry point exports `precomputeConfiguration(configuration, context, options?)` alongside the parsers and serializer. It resolves rules for one context into a precomputed-only configuration without network calls, provider initialization, or tracking. The Node package re-exports the same implementation; see its [local precomputation guide](../node-server/README.md#local-precomputation) for input validation, omission diagnostics, opt-out policy, and SSR safety constraints.

The helper follows the Rust assignment-only precomputation contract: complete successful assignments are included in `attributes.flags`, individual failures are included in the sibling `attributes.flagEvaluationErrors` map, no-assignment outcomes are absent from both maps, and no application defaults are fabricated. Dependency graph failures fail the root even when the prerequisite itself has a no-assignment outcome. Both successful assignments and failures retain ordered `dependencyEvaluations`; `isPresentInAssignment` distinguishes prerequisites on the selected assignment path from speculative evaluations that were rolled back. Typed single-flag evaluation and precomputation share the protobuf assignment resolver. The JSON scalar/null cases in the helper's tests mirror `precomputed_object_variation_preserves_scalar_json_values` in the Rust evaluator's `rules_based/precomputed.rs` tests.

Passing an `obfuscation` descriptor hashes keys in both top-level maps using `flag-key-sha256-v1`. Each nested dependency `flagKey` is instead authenticated ciphertext bound to the plaintext root key: AES-256-GCM with a key derived by HKDF-SHA256 from the root key and response salt, the shared dependency-key domain as AAD, and the unpadded base64url envelope `nonce || ciphertext || tag`. Plain precomputed packets retain plaintext dependency keys. This local helper produces the capable packet shape directly; HTTP capability forwarding and cache partitioning remain the responsibility of the delivery layer.

## Preparing activation timestamps

Rules configurations are snapshots. The protobuf decoder prepares randomization activation
timestamps once, and the Node provider prepares JSON configurations in `setConfiguration`.
Invalid activation marks only the affected flag as a parse error, regardless of opt-out mode.
Evaluation compares the prepared seconds and fractional seconds without reparsing the timestamp;
using a JavaScript `Date` here would lose the nanosecond precision needed at the opt-out cutoff.

Direct JSON core consumers can call `prepareUniversalFlagConfiguration(configuration)` when
receiving configuration. Existing low-level evaluation calls still accept raw configurations
and prepare each flag once on first use. Replace changed flags instead of mutating prepared
flags in place. Preparation does not change the serialized configuration.

## Precomputed dependent assignments

Successful dependency records contain only `flagKey` and `isPresentInAssignment`; their
assignment details come from the dependency's top-level flag entry. Root-relative dependency
failures remain inline error records and never include `isPresentInAssignment`.

`attributes.flags` contains only complete assignments. Terminal root failures are carried in
the sibling `attributes.flagEvaluationErrors` map under the failed flag key. The two maps are
mutually exclusive by key. A capable client resolves an entry from `flagEvaluationErrors` with
the caller's default while retaining its `reason`, `errorCode`, and dependency telemetry. Older
clients ignore the sibling map and therefore treat the failed flag as absent; no placeholder
assignment value is fabricated.

For obfuscated responses, keys in both maps are hashed. Each `dependencyEvaluations[].flagKey`
is authenticated ciphertext bound to the plaintext root key. The capable client decrypts the
reference with the caller-supplied root key, hashes the recovered plaintext prerequisite key,
and uses that digest for the top-level lookup. Plain responses keep plaintext dependency keys.

When a present prerequisite produces no assignment, the root is terminally returned as
`reason: "ERROR"` with `errorCode: "GENERAL"`, and the prerequisite is an inline dependency
error. The server does not continue to a later root fallback, and the unassigned prerequisite
does not receive a standalone top-level flag entry.

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
