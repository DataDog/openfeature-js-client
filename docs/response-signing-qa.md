# Response-signing QA branch build

Signing is optional and defaults to `off`. The combined browser change includes
both the request-bound X.509 verifier and provider/cache admission. `observe`
verifies when possible while accepting ordinary valid assignments; `required`
admits only verified assignments. Neither mode adds a certificate fetch or an
unsigned retry. Signed responses currently use buffered JSON (`X-stream: false`);
critical-first signed NDJSON is a future protocol extension.

From a clean checkout of the reviewed commit, with submodules initialized:

```sh
yarn install --immutable
node scripts/pack-signing-canary.js /tmp/signing-qa-packages
```

This builds core and browser from the same source commit with `BUILD_MODE=canary`,
then packs both with unique `-signing-qa.<commit>` versions. The manifest records
the commit and SHA-256 of each tarball. No npm publication, release tag, or change
to the checkout's package versions occurs. Install both tarballs together; use
an application package-manager resolution for `@datadog/flagging-core` to the
local core tarball so it cannot resolve to an unrelated registry release.

The SDK embeds the **public staging root** in
`packages/browser/src/transport/responseSigning/staging-root.json`. QA selects it
with `site: 'datad0g.com'` and
`responseSigning: { mode: 'observe', trustDatadogStaging: true }`. Both signing and
staging trust remain explicit opt-ins; active staging trust is rejected for other
sites. No root is downloaded from a response. Use that same public root for the
staging edge build. Only the leaf key and leaf/
intermediate certificates go into the edge Secret Store; issuer private keys
never enter the application or npm artifacts.

Separate staging deployments can use distinct leaf/intermediate chains beneath
this root, stored in their own Secret Stores. Hostname aliases for the same
deployment do not require separate SDK pins. These are response-signing
certificates, independent of HTTPS certificates. The proof binds the exact request
hostname, but the verifier does not enforce certificate-to-hostname authorization:
the shared staging root is one trust boundary across enrolled deployments.

Begin with `observe`, then test `required` in a bounded QA session. Keep the same
provider and public root while rotating the leaf, then the intermediate. Record
the HTTP 200s, `onVerification` outcome, and network request count. The diagnostic
callback emits each distinct outcome at most once per provider; count requests
at the transport when collecting per-request evidence.

Turning the server signing switch off produces unsigned assignments. Observe
continues to accept them. Required intentionally rejects them, so roll the client
back to observe/off before disabling signing server-side.
