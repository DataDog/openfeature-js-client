# Shared response-signing fixtures

Both folders are byte-for-byte copies from
[DataDog/ffe-system-test-data](https://github.com/DataDog/ffe-system-test-data) at one pinned commit.

- Source commit: `8dfd544b1a2e8e3a06ca78a31568003a15c7ecae`
- `chain/` is a copy of `response-signing/chain/`: the test-CA credentials, the test roots, the root-EKU
  variants and the public us1.staging DC intermediate. `chain/manifest.json` records the SHA-256 of each file.
  The SHA-256 of `chain/manifest.json` is `78d91dc598fe051a15afd07485c47a73f3d4f08d227e377cc8e5bad11665f984`.
- `v1/` is a copy of `response-signing/v1/`. `v1/README.md` lists its hashes. The SHA-256 of
  `v1/manifest.json` is `cd97bbe1893671c57cf02d23ba06cf5c71e8961c3afc069aadb9ad4a18e17fde`.
- Do not edit or reformat these files. Change them upstream, then copy both folders from the new commit
  and update this commit and the hashes in the same change.

To refresh from a new commit `<sha>` with a local clone of ffe-system-test-data:

```sh
git -C <clone> fetch origin <sha>
rm -rf chain && git -C <clone> archive <sha> response-signing/chain | tar -x --strip-components=1
shasum -a 256 chain/* v1/*.json
```
