import type { Configuration, InitConfiguration } from '@datadog/browser-core'
import { validateAndBuildConfiguration, display } from '@datadog/browser-core'
import type { DDRum } from '../openfeature/rumIntegration'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import { createFlagsConfigurationFetcher } from '../transport/fetchConfiguration'

/**
 * Init Configuration for the Flagging SDK.
 */
export interface FlaggingInitConfiguration extends InitConfiguration {
  /**
   * The application ID for flagging.
   */
  applicationId: string

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
    /**
     * Whether to log exposures in RUM
     * @deprecated Use enableExposureLogging instead. This legacy approach logs exposures as RUM actions.
     */
    ddExposureLogging?: boolean
  }

  /**
   * Whether to enable exposure logging via the exposures intake
   */
  enableExposureLogging?: boolean

  /**
   * Custom headers to add to the request to the Datadog API.
   */
  customHeaders?: Record<string, string>

  /**
   * Whether to overwrite the default request headers.
   */
  overwriteRequestHeaders?: boolean
}

export interface FlaggingConfiguration extends Configuration {
  fetchFlagsConfiguration: (context: EvaluationContext) => Promise<FlagsConfiguration>
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

  return {
    fetchFlagsConfiguration: createFlagsConfigurationFetcher(initConfiguration),
    ...baseConfiguration,
  }
}
