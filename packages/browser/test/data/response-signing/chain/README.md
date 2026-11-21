# Response signing v1 certificate-chain credentials

These files test how a client verifier builds and checks a v1 certificate chain.
They are test data only. Never trust these keys or certificates outside tests.

Before this folder existed, the iOS, Android and browser SDKs each kept a copy of these
files. The copies were byte-identical. SDKs now take them from this folder at a pinned
commit, together with `../v1/`.

`manifest.json` records the SHA-256 of each file and the expected result.
`ci/validate-response-signing.py` checks the hashes and the credential shape.

## Credentials

A local test certificate authority issued these credentials and roots. Each credential
JSON file holds a public synthetic leaf private key (PKCS #8 DER), the leaf certificate
and `intermediates_der_base64`. Index 0 issued the leaf. Pin `root-a.pem` or
`root-b.pem` as the trust anchor.

| Credential | Chain | Anchor | Expected result |
| --- | --- | --- | --- |
| `two-intermediates.json` | root A, upper intermediate (pathLen 1), lower intermediate (pathLen 0), leaf with the FFE EKU | `root-a.pem` | accept |
| `backup-root.json` | the same layout under root B | `root-b.pem` | accept |
| `rotated-lower-intermediate.json` | a new lower intermediate under the same upper intermediate | `root-a.pem` | accept |
| `one-intermediate.json` | root A, one intermediate (pathLen 0), leaf with the FFE EKU | `root-a.pem` | accept |
| `other-product.json` | the leaf EKU is only the product B OID | `root-a.pem` | reject (leaf EKU) |
| `codesigning-leaf.json` | root A, one intermediate, leaf with only `codeSigning` | `root-a.pem` | reject (leaf EKU) |
| `missing-upper-intermediate.json` | the lower intermediate only | `root-a.pem` | reject (no pinned root issued the chain) |
| `unrelated-root.json` | a chain under a root that is not pinned | `root-a.pem` | reject (no pinned root issued the chain) |

The leaves are valid for 72 hours from issuance. Tests must use a fixed time inside
that period, so the files do not need regeneration when the leaves expire.

## Root rule variants

`generate-root-eku.sh` uses OpenSSL to generate `root-eku-chain.json` and the root
variants below. All variants have the same root key and subject, so each one can
anchor `root-eku-chain.json`. Each variant changes only one root rule.

| Root | Expected result |
| --- | --- |
| `root-eku-none.pem` | accept (no EKU) |
| `root-eku-ffe.pem` | accept |
| `root-eku-any.pem` | accept (`anyExtendedKeyUsage`) |
| `root-eku-codesigning-ffe.pem` | accept |
| `root-eku-codesigning.pem` | reject (an EKU without the FFE OID or `anyExtendedKeyUsage`) |
| `root-pathlen-0.pem` | reject (the path length is less than the number of intermediates) |

## Staging intermediate

`staging-us1-dc-intermediate.pem` is the real `us1.staging.dog` DC intermediate
(`CN=Datadog Customer Signing Intermediate CA - us1.staging.dog`). A test can check
that it chains to the pinned staging root
(`CN=Datadog Customer Signing Root CA - staging`, SHA-256
`0e469f3cecc9cd51fd64373879636540512d56e99eecd70361c78b98c47ea934`).

The FFE EKU OID `1.3.6.1.4.1.99999.1.1` is a staging placeholder. Datadog must assign
the production OID before production support.
