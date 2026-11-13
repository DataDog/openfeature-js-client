# Response signing fixtures

Public v1 is the first release of this protocol. Earlier v1/v2 POCs and the draft
v3 format were never public compatibility targets. The native verifier rejects
prototype request versions, response versions and transcript domains; X.509 v3
certificate encoding is unchanged.

The core corpus and nested-DER certificate regressions come from the exact
`ffe-system-test-data` revision pinned by `../../ffe-response-signing-data`.
Initialize it with `git submodule update --init packages/browser/test/ffe-response-signing-data`
from the repository root. CI checks out submodules and Dependabot proposes pin updates.

Run `yarn workspace @datadog/openfeature-browser test --runInBand test/transport/responseSigning/verification.spec.ts`.
The verifier consumes all 46 core response cases and both nested-DER cases; the
two private-key matching cases apply only to server signers. Tests check the
original fixture hashes so byte changes require deliberate review. The separate
public-only KeyUsage regression remains a native supplementary test.

These files are test inputs and are not included in the published SDK. Loading
them adds no runtime network requests, certificate fetches or trust anchors.
