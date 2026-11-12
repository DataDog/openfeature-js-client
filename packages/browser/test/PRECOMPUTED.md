# Shared precompute verification

`precomputed.spec.ts` consumes the same snapshot as the iOS and Android fixture drafts:
`DataDog/ffe-system-test-data@9afc3f75c3fef9643a9c1b5e2b1e5a9adac48177`.

The runner discovers all cases and applies upstream `web` filters. It runs each
applicable case with signing off and required. Required mode signs the original
response bytes with public test credentials. Native WebCrypto verifies the proof.
The runner checks public OpenFeature results and actual exposure/evaluation events.
SDK diagnostic records use a separate schema and are excluded from those event streams.
These are mocked transport integration tests, not deployed staging evidence.

Run from the repository root:

```sh
python3 ci/sync-precomputed-fixtures.py --verify
yarn workspace @datadog/flagging-core build:cjs
yarn workspace @datadog/openfeature-browser test --runInBand test/precomputed.spec.ts
```

The importer preserves numeric tokens in `responses/`. Do not serialize the parsed
fixture response or edit imported files. Refresh with the shared importer and a
reviewed full fixture SHA. CI verifies snapshot digests before running the tests.

## Current contract gaps

The snapshot has 63 cases. Upstream filters exclude 45 for web. Of the 18 applicable
cases, 12 pass and six fail in each signing mode. Keep these failures visible:

- `serial-id-on-exposure`: the fixture omits `createdAt`; the browser rejects it.
- `defaults-and-emission-gates`: an unsupported variation type returns `TYPE_MISMATCH`
  instead of the shared `FLAG_NOT_FOUND` expectation.
- `empty-flags-response`: browser error evaluations exceed the fixture's event expectations.
- `numeric-decimal-{float,integer,number}`: the browser rounds an inexact whole
  number instead of returning the default with `TYPE_MISMATCH`.

The same failures occur without signing. This draft adds no runtime changes or local
skips. Reconcile the shared contract before merging. The mobile PR stack is temporary;
the shared corpus and these assertions are intended to remain.
