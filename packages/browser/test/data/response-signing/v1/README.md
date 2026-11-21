# Shared response-signing v1 fixtures

These files are byte-for-byte copies of `response-signing/v1` from
[DataDog/ffe-system-test-data](https://github.com/DataDog/ffe-system-test-data).

- Source commit: `8dfd544b1a2e8e3a06ca78a31568003a15c7ecae`. The files are unchanged since `19afb2b14a3189fbffa380710523448fb73545bc`.
- Do not edit or reformat these files. Change them upstream, then copy the new commit here.
- Update the commit and the hashes below in the same change.
- `verification.spec.ts` pins the `manifest.json` SHA-256 and checks every suite against the manifest.

| File                              | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `manifest.json`                   | `cd97bbe1893671c57cf02d23ba06cf5c71e8961c3afc069aadb9ad4a18e17fde` |
| `corpus.json`                     | `ecb757b8b79a209467fee79d98e010285013c62717b1e5176ef122b77bf59a1e` |
| `isolated-certificate-rules.json` | `f65d7bc55bcffa95844a23006eb6678939c38b6e47bd58970243970f7ff3b326` |
| `nested-der.json`                 | `dafdd19b167ad4acb3d140c86d21511129bd3855660d2f6c93459b12e8e3a6a3` |
| `subject-der.json`                | `2857daab41adf5a811150d5bbc3d504c9065a00650d579f07e04f583b3d27ae6` |
| `near-expiry.json`                | `0b1c16e83e9da2eda56b85fde9922150a408b47b3f86bed18e1708b8a5e88ecd` |
| `extension-profile.json`          | `252fb5b06fad65f56d0fe2f333731c2a4e3994d2377fdfe8b368d489d9f3a8dc` |

To refresh from a new commit `<sha>`:

```sh
for f in manifest.json corpus.json isolated-certificate-rules.json nested-der.json \
  subject-der.json near-expiry.json extension-profile.json; do
  gh api -H 'Accept: application/vnd.github.raw' \
    "repos/DataDog/ffe-system-test-data/contents/response-signing/v1/$f?ref=<sha>" > "$f"
done
shasum -a 256 *.json
```
