# UFC protobuf schema

`ufc.proto` is copied byte-for-byte from
[`ddoghq/dd-source#70386`](https://github.com/ddoghq/dd-source/pull/70386) at merge commit
`15f7187d7e8958738af06bae117895ab01ccfc03`.

After updating the schema, regenerate the TypeScript definitions from the repository root:

```sh
yarn workspace @datadog/flagging-core generate:protobuf
```
