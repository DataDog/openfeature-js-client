import type { Context } from '@datadog/browser-core'
import {
  createBatch,
  createFlushController,
  createHttpRequest,
  createIdentityEncoder,
  createPageMayExitObservable,
  generateUUID,
  noop,
  Observable,
  timeStampNow,
} from '@datadog/browser-core'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import type { FlaggingConfiguration } from '../domain/configuration'

const FEATURE_FLAGS_TELEMETRY_SERVICE = 'browser-feature-flags-sdk'
const FEATURE_FLAGS_SDK_NAME = 'dd-openfeature-browser'
const LIFECYCLE_LOG_MESSAGE = 'Feature Flags SDK lifecycle'

type LifecycleEventType = 'sdk_init_started' | 'configuration_received' | 'first_evaluation'

export function createFeatureFlagsLifecycleTelemetry(configuration: FlaggingConfiguration) {
  const pageMayExitObservable = createPageMayExitObservable(configuration)
  const batch = createBatch({
    encoder: createIdentityEncoder(),
    request: createHttpRequest([configuration.rumEndpointBuilder], noop),
    flushController: createFlushController({
      pageMayExitObservable,
      sessionExpireObservable: new Observable(),
    }),
  })
  const runtimeId = generateUUID()
  const sentEvents = new Set<LifecycleEventType>()

  function emit(eventType: LifecycleEventType, attributes: Context = {}) {
    if (sentEvents.has(eventType)) {
      return
    }
    sentEvents.add(eventType)

    const timestamp = timeStampNow()
    batch.add({
      type: 'telemetry',
      date: timestamp,
      service: FEATURE_FLAGS_TELEMETRY_SERVICE,
      version: __BUILD_ENV__SDK_VERSION__,
      source: 'browser',
      _dd: {
        format_version: 2,
      },
      telemetry: {
        type: 'log',
        status: 'debug',
        message: LIFECYCLE_LOG_MESSAGE,
        product: 'feature_flags',
        event_type: eventType,
        timestamp,
        runtime_id: runtimeId,
        ...(configuration.applicationId && { application_id: configuration.applicationId }),
        ...(configuration.service && { service: configuration.service }),
        ...(configuration.env && { environment: configuration.env }),
        sdk_name: FEATURE_FLAGS_SDK_NAME,
        sdk_version: __BUILD_ENV__SDK_VERSION__,
        ...attributes,
      },
    })
  }

  return {
    sdkInitStarted() {
      emit('sdk_init_started', { provider_status: 'not_ready' })
    },

    configurationReceived(flagsConfiguration: FlagsConfiguration) {
      const precomputed = flagsConfiguration.precomputed
      emit('configuration_received', {
        configuration_source: 'remote',
        ...(precomputed?.response.data.attributes.createdAt !== undefined && {
          configuration_version: String(precomputed.response.data.attributes.createdAt),
        }),
        ...(precomputed?.fetchedAt !== undefined && {
          configuration_fetched_at: precomputed.fetchedAt,
        }),
      })
    },

    firstEvaluation(providerStatus: string) {
      emit('first_evaluation', { provider_status: providerStatus.toLowerCase() })
    },

    stop() {
      batch.stop()
    },
  }
}

export type FeatureFlagsLifecycleTelemetry = ReturnType<typeof createFeatureFlagsLifecycleTelemetry>
