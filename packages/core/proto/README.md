# UFC protobuf schema

`ufc.proto` is copied byte-for-byte from the `dd-source`
`dependent-flags-variant-key-ufc` branch. Keep both copies synchronized when
the schema changes.

After updating the schema, regenerate the TypeScript definitions from the repository root:

```sh
yarn workspace @datadog/flagging-core generate:protobuf
```
