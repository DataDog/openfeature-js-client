# Edge consent responses

`edge-consent.json` contains output from the Edge handler at dd-source commit
`4cfede81d80e28bb613c858e5ac0b488a4bc7761` (merged in PR 138467).
These are synthetic backend test assignments, not organization data.

Generated from `create_representative_ufc_config_response` and `deliver` in
`domains/ffe/apps/edge-assignments/src/handlers/precompute_assignments/tests/consent.rs`,
setting `observeFullEvaluationData` to false/true and enumerating regular/optimized,
buffered/streamed, plain/obfuscated delivery with cache bypass disabled.
A temporary test printed each decoded response; the helper's final normalization
was bypassed to retain the actual `createdAt` field. Production code was unchanged.
The local Fastly/WASM test ran with:

```sh
bzl test --remote_executor= --remote_cache= --spawn_strategy=local \
  //domains/ffe/apps/edge-assignments:test \
  --test_arg=emit_client_consent_fixtures --test_arg=--nocapture --test_output=all
```

`precomputed-consent.spec.ts` consumes every response using locally packed core and
browser packages in Chromium. Run `yarn test:browser-install` from the repository root.
