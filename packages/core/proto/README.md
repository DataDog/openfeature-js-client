# UFC protobuf schema

`ufc.proto` is copied byte-for-byte from
[`ddoghq/dd-source#30526`](https://github.com/ddoghq/dd-source/pull/30526) at commit
`8ccbeb1fe2696913506fb61d2e7a4598ea5ec449`.

After updating the schema, regenerate the TypeScript definitions from the repository root:

```sh
yarn workspace @datadog/flagging-core generate:protobuf
```
