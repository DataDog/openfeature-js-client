import {
  composeDatadogTrackingHooks,
  configurationFromString,
  createDatadogExposureLoggingHook,
  DatadogCoreProvider,
  ExposureHook,
} from '@datadog/openfeature-browser/rules-based'
import { OpenFeature } from '@openfeature/web-sdk'
import { reportError, reportSuccess } from './smoke'

// Rules wire with one doLog allocation, a serial id, and HOOK/EXPOSURE split
// features, matching the vendored protobuf schema.
const RULES_WIRE =
  '{"version":1,"rules":{"response":"CgASBHRlc3QajgEKDGJyb3dzZXItZmxhZxJ+EAQaAigBInYKCmFsbG9jYXRpb24aERIPCgpzbW9rZS1zYWx0GJBOIlMKBQgAEJBOGCogAioiCgtob2xkb3V0LmtleRINc21va2UtaG9sZG91dCoESE9PSyoiCgxleHBvc3VyZS50YWcSCHJlY29yZGVkKghFWFBPU1VSRSgBIgIKACoCb24="}}'

async function run(): Promise<void> {
  // Record-only: the customer records exposures itself, nothing goes to Datadog.
  const exposureTracking = createDatadogExposureLoggingHook({
    clientToken: 'test-client-token',
    applicationId: 'test-app-id',
    site: 'datad0g.com',
    env: 'test',
    trackExposures: false,
  })
  const tracking = composeDatadogTrackingHooks(exposureTracking)
  await tracking.initialize()

  const provider = new DatadogCoreProvider({ exposureCache: tracking.exposureCache })
  provider.setConfiguration(configurationFromString(RULES_WIRE))
  await OpenFeature.setProviderAndWait('datadog-core', provider, { targetingKey: 'smoke-user' })

  const client = OpenFeature.getClient('datadog-core')
  client.addHooks(...tracking.hooks)

  const verdicts: string[] = []
  OpenFeature.addHooks(
    new ExposureHook((evaluation) => {
      if (!evaluation.isExposure()) return
      verdicts.push(evaluation.isCacheHit() ? 'cache-hit' : evaluation.shouldSend() ? 'new' : 'repeat')
    })
  )

  const first = client.getBooleanDetails('browser-flag', false)
  const second = client.getBooleanDetails('browser-flag', false)

  await tracking.shutdown()

  reportSuccess({
    provider: provider.metadata.name,
    value: first.value,
    variant: first.variant,
    verdicts,
    firstVerdict: first.flagMetadata?.__dd_exposure_cache_hit,
    secondVerdict: second.flagMetadata?.__dd_exposure_cache_hit,
  })
}

void run().catch(reportError)
