# UFC protobuf schema

The dependent-flag fields in `ufc.proto` come from
[`dd-source` commit `d748d9e77c51ae5a4d5e4a7101a812204f86a95a`](https://github.com/ddoghq/dd-source/blob/d748d9e77c51ae5a4d5e4a7101a812204f86a95a/domains/ffe/libs/flagging/ufc/ufcpb/ufc.proto),
merged by [dd-source PR #126439](https://github.com/ddoghq/dd-source/pull/126439).
Use immutable commits when synchronizing later schema changes.

After updating the schema, regenerate the TypeScript definitions from the repository root:

```sh
yarn workspace @datadog/flagging-core generate:protobuf
```
