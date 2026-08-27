import type { Configuration, EndpointBuilder, InitConfiguration } from '@datadog/browser-core'
import { validateAndBuildConfiguration } from '@datadog/browser-core'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import type { DDRum } from '../openfeature/rumIntegration'
import { createFlagsConfigurationFetcher } from '../transport/fetchConfiguration'

/**
 * Init Configuration for the Flagging SDK.
 */
export interface FlaggingTrackingInitConfiguration extends InitConfiguration {
  /**
   * The RUM application ID.
   */
  applicationId?: string

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
   * Whether to enable RUM integration (default: true). This includes feature flag assignment details in RUM events
   * and flat primitive RUM user properties in the OpenFeature evaluation context.
   * See: https://docs.datadoghq.com/real_user_monitoring/feature_flag_tracking/
   */
  enableRumFeatureFlagTracking?: boolean

  /**
   * Flag evaluation tracking interval in milliseconds (default: 10000ms)
   */
  flagEvaluationTrackingInterval?: number
}

/**
 * Init Configuration for the online Flagging provider.
 */
export interface FlaggingInitConfiguration extends FlaggingTrackingInitConfiguration {
  /**
   * Initial flags configuration (precomputed flags)
   */
  initialFlagsConfiguration?: FlagsConfiguration

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

export interface FlaggingTrackingConfiguration extends Configuration {
  applicationId?: string
  flagEvaluationTrackingInterval: number

  // Inherited from Configuration via TransportConfiguration.
  // Declared explicitly here to make the contract visible to consumers of FlaggingTrackingConfiguration.
  flagEvaluationEndpointBuilder: EndpointBuilder
}

export interface FlaggingConfiguration extends FlaggingTrackingConfiguration {
  fetchFlagsConfiguration: (
    context: EvaluationContext,
    options?: { signal?: AbortSignal }
  ) => Promise<FlagsConfiguration>
}

export function validateAndBuildFlaggingTrackingConfiguration(
  initConfiguration: FlaggingTrackingInitConfiguration
): FlaggingTrackingConfiguration | undefined {
  const baseConfiguration = validateAndBuildConfiguration(initConfiguration)
  if (!baseConfiguration) {
    return
  }

  return {
    applicationId: initConfiguration.applicationId,
    flagEvaluationTrackingInterval: initConfiguration.flagEvaluationTrackingInterval ?? 10000,
    ...baseConfiguration,
  }
}

export function validateAndBuildFlaggingConfiguration(
  initConfiguration: FlaggingInitConfiguration
): FlaggingConfiguration | undefined {
  const trackingConfiguration = validateAndBuildFlaggingTrackingConfiguration(initConfiguration)
  if (!trackingConfiguration) {
    return
  }

  return {
    fetchFlagsConfiguration: createFlagsConfigurationFetcher(initConfiguration),
    ...trackingConfiguration,
  }
}
