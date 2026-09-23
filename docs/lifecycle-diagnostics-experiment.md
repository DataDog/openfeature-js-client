# Browser lifecycle diagnostic experiment

This branch adds **experimental lifecycle telemetry** to the precomputed browser provider. Telemetry is emitted whether `debugMode` is omitted, false, or true. The disabled-by-default `debugMode` option controls only local console diagnostics. This is not a production telemetry release; the backend experiment currently accepts diagnostics only for explicitly supported staging test traffic.

```js
new DatadogProvider({
  clientToken: 'PUBLIC_CLIENT_TOKEN',
  applicationId: 'APPLICATION_ID',
  env: 'staging',
  site: 'datad0g.com',
  debugMode: true, // Optional console logging; telemetry is emitted without it.
})
```

Debug mode prints local lifecycle and evaluation details, including values, to the developer console. Enable it only where that output is appropriate. Independently, the provider sends lifecycle telemetry in a separate JSONL batch on the existing flag-evaluation transport. Those records use `event_family: 'sdk_diagnostic'`, `schema_version: 1`, and a bounded diagnostic payload; they contain no flag key, value, context, targeting key, arbitrary error message, stack trace or organization ID. Client tokens authenticate the request, not the payload. No RUM/APM installation or initialization is required, and this works with evaluation/exposure/RUM reporting disabled. Lifecycle upload/queue errors are also printed only when debugMode is enabled; telemetry failures never enable console output on their own.

Events are `sdk_init_started`, `configuration_received`, `provider_ready`, `provider_error`, `init_timeout`, and `init_failed`. The last three use fixed codes `CONFIG_FETCH_FAILED`, `INIT_TIMEOUT`, and `INIT_FAILED`. The fetch code is intentionally generic. There is no `first_evaluation` diagnostic: use genuine evaluation reporting for that stage.

Each provider instance has one runtime ID and emits each transition once (including repeated failures of the same class). A 30-second timer observes slow initialization but does not cancel it; success may arrive later. A failed fetch with cached fallback emits an error without claiming fresh readiness. Superseded requests are not failures. Telemetry upload errors never change evaluation results or generate further diagnostic events. Missing telemetry is unknown, not a confirmed failure.

Remote diagnostics require an `env` plus an `applicationId` or `service`. The payload contains exactly one identity: application_id wins when both are configured; otherwise service_id is the configured service name. Invalid or missing identity/environment leaves diagnostic output local without affecting flag evaluation.

The backend experiment stores every accepted diagnostic in a separate, non-billable storage scope on the evaluation track, configured for one-day retention. It does not sample, aggregate by minute, or deduplicate different records or runtimes. Query results preserve each record's `runtime_id`; they are observed evidence, not proof of current health or of which snippet a person ran. Evaluation queries exclude diagnostics, and evaluation retention is unchanged. The SDK emits once per transition per runtime regardless of debugMode. Retention limits stored history, not the cost of receiving and indexing each event; deployment and effective retention still need staging verification.

Each diagnostic record is limited to 2 KiB and a runtime produces at most six. The existing Browser SDK batching/retry/page-exit helpers supply transport; periodic flushing can delay visibility by up to the normal batch interval (30 seconds), and page-exit delivery is best effort. Closing the provider flushes pending diagnostics and disconnects its page-exit subscription. No new Browser SDK version is needed by this branch.

## Local harness

Run the repository's browser-package installation smoke test (`yarn test:browser-install`) to package the local core/browser SDK and install the test-app dependencies. Then run `yarn dev` from `test-app` and open `/diagnostics.html`.

Enter your staging client token/application/environment. Choose normal, rejected, or delayed configuration fetch; the override does not intercept telemetry upload. Open developer tools before initialization. A clean failure requires no cached/initial configuration: clear this page's IndexedDB or use a fresh profile. Use the close button to flush immediately. Use a separate authenticated management-plane page to query remote evidence—never an API key in this browser app.

The harness optionally reports real evaluations for regression comparisons. Initialization telemetry does not require entering or evaluating a flag. Credentials are not persisted by the harness. This does not replace real staging storage/query verification or establish production retention and cost.
