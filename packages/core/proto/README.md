# UFC protobuf schema

`ufc.proto` is copied byte-for-byte from
[`ddoghq/dd-source#59643`](https://github.com/ddoghq/dd-source/pull/59643) at commit
`31332ecb15d9ad75445228e2c4939db4a4aad19a`.

After updating the schema, regenerate the TypeScript definitions from the repository root:

```sh
yarn workspace @datadog/flagging-core generate:protobuf
```
