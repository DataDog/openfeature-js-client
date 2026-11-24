# Shared response-signing v1 fixtures

These files are byte-for-byte copies of `response-signing/v1` from
[DataDog/ffe-system-test-data](https://github.com/DataDog/ffe-system-test-data).

- Source commit: `fe24ed2c4872bf109b0c71ffb2229152d76b8963` (DataDog/ffe-system-test-data#80, merged). Every rejected case has an `sdk_reason`: the shared reason code.
- Do not edit or reformat these files. Change them upstream, then copy the new commit here.
- Update the commit and the hashes below in the same change.
- `verification.spec.ts` pins the `manifest.json` SHA-256 and checks every suite against the manifest.

| File                              | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `manifest.json`                   | `eba3f9a9053d0d7bd89f432f882585873dd8c39b68b73b604841ac1dc27b329c` |
| `corpus.json`                     | `ab180a3df50b4046cc97b695c1062ae0dc156975dd512987c087335765191972` |
| `isolated-certificate-rules.json` | `9d2273e5b9bf940b5dd6a4d9e376853cceafe8a3c4347e761d3e2058a78b0274` |
| `nested-der.json`                 | `978f7494ff59ba49a8f7cdaa2edbed2c8d81b03d0f44a86bafc71c823a9dd540` |
| `subject-der.json`                | `6dd2616fb9b61794a2bd1511797400902b8403d0887b3845fc096d0a34fb22e6` |
| `near-expiry.json`                | `bfda185688dafb718f7b0b1c98878a87cd09d64317ec5eb47cf090bd4590e3b1` |
| `extension-profile.json`          | `0e5d04e6f23810021cf74f2ca84b3dcf036453c2620cfe8171ae7795c160a4ba` |

To refresh from a new commit `<sha>`:

```sh
for f in manifest.json corpus.json isolated-certificate-rules.json nested-der.json \
  subject-der.json near-expiry.json extension-profile.json; do
  gh api -H 'Accept: application/vnd.github.raw' \
    "repos/DataDog/ffe-system-test-data/contents/response-signing/v1/$f?ref=<sha>" > "$f"
done
shasum -a 256 *.json
```
