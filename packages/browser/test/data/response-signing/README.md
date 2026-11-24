# Shared response-signing fixtures

Both folders are byte-for-byte copies from
[DataDog/ffe-system-test-data](https://github.com/DataDog/ffe-system-test-data) at one pinned commit.

- Source commit: `fe24ed2c4872bf109b0c71ffb2229152d76b8963`. `chain/manifest.json` has the fixed test time `now` and a `rejection_reason` for each rejected entry.
- `chain/` is a copy of `response-signing/chain/`: the test-CA credentials, the test roots, the root-EKU
  variants and the public us1.staging DC intermediate. `chain/manifest.json` records the SHA-256 of each file.
  The SHA-256 of `chain/manifest.json` is `2d2ac112d61b481c5f1e634f705eb24b8cce10b2f2db9918e8ef60e2ed6e5f7e`.
- `v1/` is a copy of `response-signing/v1/`. `v1/README.md` lists its hashes. The SHA-256 of
  `v1/manifest.json` is `eba3f9a9053d0d7bd89f432f882585873dd8c39b68b73b604841ac1dc27b329c`.
- Do not edit or reformat these files. Change them upstream, then copy both folders from the new commit
  and update this commit and the hashes in the same change.

To refresh from a new commit `<sha>` with a local clone of ffe-system-test-data:

```sh
git -C <clone> fetch origin <sha>
rm -rf chain && git -C <clone> archive <sha> response-signing/chain | tar -x --strip-components=1
shasum -a 256 chain/* v1/*.json
```
