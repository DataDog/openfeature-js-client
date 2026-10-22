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

Debug mode prints local lifecycle and evaluation details, including values, to the developer console. Enable it only where that output is appropriate. Independently, the provider sends lifecycle telemetry in a separate JSONL batch on the existing flag-evaluation transport. Those records use `type: 'sdk_diagnostic'`, `schema_version: 1`, and a bounded diagnostic payload; they contain no flag key, value, context, targeting key, arbitrary error message, stack trace or organization ID. Client tokens authenticate the request, not the payload. No RUM/APM installation or initialization is required, and this works with evaluation/exposure/RUM reporting disabled. Lifecycle upload/queue errors are also printed only when debugMode is enabled; telemetry failures never enable console output on their own.

The wire contract matches [dd-source PR #98932](https://github.com/ddoghq/dd-source/pull/98932): `POST /api/v2/flagevaluation`, `Content-Type: text/plain`, with one compact JSON diagnostic envelope per line. Diagnostics have their own batch and are never placed inside `flagEvaluations` or mixed with evaluation records. The tests validate serialized requests against the canonical backend JSON schema copied into `packages/browser/test/data/sdkdiagnostic-v1.json` (Git blob `4684d81842d6a824a1c957916cb94d9ca8de9fc1`). Synchronize that fixture when the backend contract changes.

Initialization produces one `event_type: "sdk_initialization"` report:

| Outcome | Final | Error code | Milestones |
| --- | --- | --- | --- |
| `ready` | true | omitted | `configuration_received`, `provider_ready` |
| `failed` | true | `INIT_FAILED` | configuration optional, no readiness |
| `cached_fallback` | true | `CONFIG_FETCH_FAILED` | empty |
| `incomplete` | false | omitted | configuration optional, no readiness |

Reports include `started_at` (Unix milliseconds), `duration_ms`, `sequence`, `final`, and `milestones`. Milestone `elapsed_ms` and duration use a monotonic clock. Optional TCP/first-byte timings are omitted because this provider does not measure them. Invalid timing or payloads above 2,048 UTF-8 bytes are not uploaded.

At 30 seconds, page exit, or provider close before initialization settles, emit at most one `incomplete` snapshot with sequence 0 and reason `deadline`, `page_exit`, or `provider_closed`. A later final report has sequence 1 and retains the runtime ID and start time; without a snapshot it has sequence 0. The deadline only observes pending initialization; it does not cancel it or report failure. Page exit is best effort and a resumed page may still finish initialization.

After initialization settles, a configuration fetch failure emits `event_type: "provider_error"` with `error_code: "CONFIG_FETCH_FAILED"`, once per runtime. This has no initialization fields. Initial fetch failure with usable cached configuration is `cached_fallback`, not a separate provider error. Superseded requests are not failures. Upload failures never change evaluation results or create provider errors. Missing telemetry remains unknown. Create a new provider instance for a new initialization attempt. There is no first-evaluation diagnostic: use genuine evaluations.

Remote diagnostics require an `env` plus an `applicationId` or `service`. The payload contains exactly one identity: application_id wins when both are configured; otherwise service_id is the configured service name. Invalid or missing identity/environment leaves diagnostic output local without affecting flag evaluation.

The backend experiment stores every accepted diagnostic in a separate, non-billable storage scope on the evaluation track, configured for one-day retention. It does not sample, aggregate by minute, or deduplicate different records or runtimes. Query results preserve each record's `runtime_id`; they are observed evidence, not proof of current health or of which snippet a person ran. Evaluation queries exclude diagnostics, and evaluation retention is unchanged. The SDK bounds reports per runtime regardless of debugMode. Retention limits stored history, not the cost of receiving and indexing each event; deployment and effective retention still need staging verification.

Each diagnostic record is limited to 2 KiB and a runtime produces at most three: an optional incomplete snapshot, one final initialization report, and one later provider error. This is below intake’s 32-record JSONL limit. The existing Browser SDK batching/retry/page-exit helpers supply transport; periodic flushing can delay visibility by up to the normal batch interval (30 seconds), and page-exit delivery is best effort. Closing the provider records an incomplete snapshot if needed, flushes pending diagnostics, cancels the observation timer, and disconnects its page-exit subscription. No new Browser SDK version is needed by this branch.

## Local harness

Run the repository's browser-package installation smoke test (`yarn test:browser-install`) to package the local core/browser SDK and install the test-app dependencies. Then run `yarn dev` from `test-app` and open `/diagnostics.html`.

Enter your staging client token/application/environment. Choose normal, rejected, or delayed configuration fetch; the override does not intercept telemetry upload. Open developer tools before initialization. A clean failure requires no cached/initial configuration: clear this page's IndexedDB or use a fresh profile. Use the close button to flush immediately. Use a separate authenticated management-plane page to query remote evidence—never an API key in this browser app.

The harness optionally reports real evaluations for regression comparisons. Initialization telemetry does not require entering or evaluating a flag. Credentials are not persisted by the harness. This does not replace real staging storage/query verification or establish production retention and cost.
