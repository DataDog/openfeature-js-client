import type { Configuration, Duration, InitConfiguration } from '@datadog/browser-core'
import { display, validateAndBuildConfiguration } from '@datadog/browser-core'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import type { DDRum } from '../openfeature/rumIntegration'
import { createFlagsConfigurationFetcher } from '../transport/fetchConfiguration'
import { createEndpointBuilder } from '@datadog/browser-core/cjs/domain/configuration'

/**
 * Init Configuration for the Flagging SDK.
 */
export interface FlaggingInitConfiguration extends InitConfiguration {
  /**
   * The RUM application ID.
   */
  applicationId?: string

  /**
   * Initial flags configuration (precomputed flags)
   */
  initialFlagsConfiguration?: FlagsConfiguration

  /**
   * RUM integration options
   * @deprecated Use enableExposureLogging instead. RUM-based exposure tracking will be removed in a future version.
   */
  rum?: {
    /**
     * The RUM SDK instance to use for tracking
     * @deprecated Use enableExposureLogging instead
     */
    sdk: DDRum
    /**
     * Whether to track feature flag evaluations in RUM
     * @deprecated Use enableExposureLogging instead
     */
    ddFlaggingTracking?: boolean
  }

  /**
   * Whether to enable exposure logging via the exposures intake
   */
  enableExposureLogging?: boolean

  /**
   * Whether to enable flag evaluation tracking via the flag evaluation intake
   */
  enableFlagEvaluationTracking?: boolean

  /**
   * Flag evaluation tracking interval in milliseconds (default: 10000ms)
   */
  flagEvaluationTrackingInterval?: number

  /**
   * Custom headers to add to the request to the Datadog API.
   */
  customHeaders?: Record<string, string>

  /**
   * Whether to overwrite the default request headers.
   */
  overwriteRequestHeaders?: boolean

  /**
   * Proxy URL for flagging configuration requests. If set, this will be used instead of the site parameter.
   */
  flaggingProxy?: string
}

export interface FlaggingConfiguration extends Configuration {
  applicationId?: string
  flagEvaluationTrackingInterval?: number
  fetchFlagsConfiguration: (context: EvaluationContext) => Promise<FlagsConfiguration>

  // [FlagEval] TODO: Remove this once we have a proper endpoint builder from browser core SDK.
  flagEvaluationEndpointBuilder?: any
}

export function validateAndBuildFlaggingConfiguration(
  initConfiguration: FlaggingInitConfiguration
): FlaggingConfiguration | undefined {
  if (!initConfiguration.applicationId) {
    display.error('Application ID is not configured, no flagging data will be collected.')
    return
  }

  const baseConfiguration = validateAndBuildConfiguration(initConfiguration)
  if (!baseConfiguration) {
    return
  }

  // [FlagEval] TODO: Don't set this once we have a proper endpoint builder from browser core SDK.
  const endpointBuilder = createEndpointBuilder(initConfiguration, 'flagevaluation' as any)

  return {
    applicationId: initConfiguration.applicationId,
    flagEvaluationTrackingInterval: initConfiguration.flagEvaluationTrackingInterval,
    flagEvaluationEndpointBuilder: endpointBuilder,
    fetchFlagsConfiguration: createFlagsConfigurationFetcher(initConfiguration),
    ...baseConfiguration,
  }
}
