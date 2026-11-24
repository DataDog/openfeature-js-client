# Response signing fixtures

Public v1 is the first release of this protocol. Earlier v1/v2 POCs and the draft
v3 format were never public compatibility targets. The native verifier rejects
prototype request versions, response versions and transcript domains; X.509 v3
certificate encoding is unchanged.

Signature version `1` carries the intermediate certificates in
`x-datadog-feature-flags-signing-chain`, and the transcript ends with
`SHA256(leaf) || u8(n) || SHA256(intermediate[0]) || ... || SHA256(intermediate[n-1])`.
`../../data/response-signing/chain/` holds test credentials issued by a local test CA (credential JSON `version` 1)
and the public test roots `root-a.pem` and `root-b.pem`. The private keys are test-only.
Leaves are valid for 72 hours, so the tests inject `now` (`FIXTURE_NOW` in `chainFixtures.ts`).
`verification.spec.ts` covers the chain fixture table, the transcript, and synthetic chains
that change one certificate-profile rule at a time.

`../../data/response-signing/chain/staging-us1-dc-intermediate.pem` is the public us1.staging DC intermediate.
A test checks that it links to the bundled staging root under the client profile.

All six shared v1 suites are byte-for-byte copies in `../../data/response-signing/v1`.
They do not use a git submodule. That folder's `README.md` records the source
`ffe-system-test-data` commit and the SHA-256 of each file, and shows how to refresh them.

Run `yarn workspace @datadog/openfeature-browser test --runInBand test/transport/responseSigning/verification.spec.ts`.
The verifier runs all 116 shared response cases: 96 core, four isolated-certificate,
two nested-DER, two subject-DER, six near-expiry and six extension-profile cases.
It skips `signing_cases`, because they apply only to signers. A case
`anchor_der_base64` replaces the file anchor for that case. Each rejected case
asserts its `sdk_reason`, the shared reason code. `rejection_reason` is a rule code. The test pins the upstream manifest hash and checks each file against the
manifest, so byte changes require a deliberate copy from a new commit. The KeyUsage
named-bit-list regression is a synthetic native test in `verification.spec.ts`.

These files are test inputs and are not included in the published SDK. Loading
them adds no runtime network requests, certificate fetches or trust anchors.
