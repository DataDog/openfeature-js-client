# Shared precompute verification

`precomputed.spec.ts` reads `precomputed-assignments/` directly from the existing
`ffe-response-signing-data` Git submodule. The same upstream repository supplies
local evaluator, flag-selection, and signing fixtures. Dependabot updates the
submodule pins through the repository's existing weekly configuration.

The runner discovers all cases and applies upstream `web` filters. It runs each
applicable case with signing off and required. Required mode signs the original
response bytes with public test credentials. Native WebCrypto verifies the proof.
The runner checks public OpenFeature results and actual exposure/evaluation events.
SDK diagnostic records use a separate schema and are excluded from those event streams.
These are mocked transport integration tests, not deployed staging evidence.

Run from the repository root:

```sh
git submodule update --init
yarn workspace @datadog/flagging-core build:cjs
yarn workspace @datadog/openfeature-browser test --runInBand test/precomputed.spec.ts
```

The test loader extracts the original response text without parsing and serializing
its numeric literals. No copied snapshot, generated sidecars, or custom sync job is
needed. To update fixtures, select a reviewed commit in the submodule and commit
its pointer in this repository.

## Current contract gaps

The corpus has 63 cases. Upstream filters exclude 45 for web. Of the 18 applicable
cases, 12 pass and six fail in each signing mode. Keep these failures visible:

- `serial-id-on-exposure`: the fixture omits `createdAt`; the browser rejects it.
- `defaults-and-emission-gates`: an unsupported variation type returns `PARSE_ERROR`
  instead of the shared `FLAG_NOT_FOUND` expectation.
- `empty-flags-response`: browser error evaluations exceed the fixture's event expectations.
- `numeric-decimal-{float,integer,number}`: the browser rounds an inexact whole
  number instead of returning the default with `TYPE_MISMATCH`.

The same failures occur without signing. The core evaluator accepts additional
dependency-reference fields and reports dependency failures using the updated
shared contract. The browser cases have no local skips. Reconcile the remaining
browser contract gaps before merging. The mobile PR stack is temporary;
the shared corpus and these assertions are intended to remain.
