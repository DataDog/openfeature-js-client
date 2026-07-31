# UFC protobuf schema

`ufc.proto` is copied byte-for-byte from
[`ddoghq/dd-source#40304`](https://github.com/ddoghq/dd-source/pull/40304) at commit
`071c4adf63e4e5b175a6b1807015c65fcdd68267`.

After updating the schema, regenerate the TypeScript definitions from the repository root:

```sh
yarn workspace @datadog/flagging-core generate:protobuf
```
