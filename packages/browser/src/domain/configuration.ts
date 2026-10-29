import type { Configuration, EndpointBuilder, InitConfiguration } from '@datadog/browser-core'
import { validateAndBuildConfiguration } from '@datadog/browser-core'
import type { FlagSelection, FlagsConfiguration } from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import type { ExperimentationOptOutConfiguration } from '../openfeature/experimentation-opt-out'
import type { DDRum } from '../openfeature/rumIntegration'
import { createFlagsConfigurationFetcher } from '../transport/fetchConfiguration'

export interface EvaluationTelemetryOptOutConfiguration {
  /**
   * Enable evaluation telemetry suppression through `dd_evaluation_telemetry_opt_out` (default: false).
   * Only boolean true suppresses new evaluation telemetry and automatic RUM flag annotations.
   * The attribute remains available to targeting and exposure reporting.
   */
  enableEvaluationTelemetryOptOutParameter?: boolean
}

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
   * Whether to track exposures (default: true). With this off, the SDK sends no
   * exposure events to Datadog, but exposure recording keeps working for the
   * customer exposure hook and the deduplication cache still records.
   */
  trackExposures?: boolean

  /**
   * Whether to enable exposure logging via the exposures intake
   * @deprecated Use trackExposures instead. When both are set, trackExposures wins.
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
export interface FlaggingInitConfiguration
  extends
    FlaggingTrackingInitConfiguration,
    EvaluationTelemetryOptOutConfiguration,
    ExperimentationOptOutConfiguration {
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

  /**
   * Fetch implementation used only for flag configuration requests. It receives the provider-generated RequestInit,
   * including authentication and configured custom headers. Exposure and flag-evaluation intake requests do not use it.
   */
  flagConfigurationFetch?: typeof globalThis.fetch

  /**
   * Load only the flags that match these tags or key patterns. Tags match exactly, and key patterns are whole-key
   * globs where only `*` is special. Fixed at initialization. A selection over a limit is not sent, and the full
   * configuration is loaded. See the README for the limits.
   */
  flagSelection?: FlagSelection
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

let warnedEnableExposureLoggingDeprecation = false

/**
 * Resolve the exposure tracking toggle: `trackExposures` wins over the deprecated
 * `enableExposureLogging`, and both default to `enabledByDefault`.
 */
export function resolveTrackExposures(
  initConfiguration: Partial<FlaggingTrackingInitConfiguration>,
  enabledByDefault: boolean
): boolean {
  if (initConfiguration.enableExposureLogging !== undefined && !warnedEnableExposureLoggingDeprecation) {
    warnedEnableExposureLoggingDeprecation = true
    console.warn(
      'enableExposureLogging is deprecated and will be removed in a future version. Use trackExposures instead.'
    )
  }
  return initConfiguration.trackExposures ?? initConfiguration.enableExposureLogging ?? enabledByDefault
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
