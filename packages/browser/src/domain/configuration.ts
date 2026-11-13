import type { Configuration, EndpointBuilder, InitConfiguration } from '@datadog/browser-core'
import { buildEndpointHost, validateAndBuildConfiguration } from '@datadog/browser-core'
import type { FlagSelection, FlagsConfiguration } from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import { createDebugLogger, type DebugConfiguration, type DebugLogger, debugOptions, debugUrl } from '../debug'
import type { ExperimentationOptOutConfiguration } from '../openfeature/experimentation-opt-out'
import type { DDRum } from '../openfeature/rumIntegration'
import { createFlagsConfigurationFetcher } from '../transport/fetchConfiguration'
import {
  createResponseSigningController,
  type ResponseSigningConfiguration,
  type ResponseSigningController,
} from '../transport/responseSigning/controller'

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
export interface FlaggingTrackingInitConfiguration extends InitConfiguration, DebugConfiguration {
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

  /** Opt-in assignment response signing. Default: off. */
  responseSigning?: ResponseSigningConfiguration

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
  /** @internal Local diagnostics, never included in remote payloads. */
  debug?: DebugLogger
  applicationId?: string
  flagEvaluationTrackingInterval: number

  // Inherited from Configuration via TransportConfiguration.
  // Declared explicitly here to make the contract visible to consumers of FlaggingTrackingConfiguration.
  flagEvaluationEndpointBuilder: EndpointBuilder
}

export interface FlaggingConfiguration extends FlaggingTrackingConfiguration {
  responseSigning?: ResponseSigningController
  fetchFlagsConfiguration: (
    context: EvaluationContext,
    options?: { signal?: AbortSignal; assignmentToken?: unknown }
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
  initConfiguration: FlaggingTrackingInitConfiguration,
  debug = createDebugLogger(initConfiguration.debugMode, 'tracking')
): FlaggingTrackingConfiguration | undefined {
  debug.event('init.configuration', () => ({ options: debugOptions(initConfiguration) }))
  let baseConfiguration: Configuration | undefined
  try {
    baseConfiguration = validateAndBuildConfiguration(initConfiguration)
  } catch (error) {
    debug.event('init.failed', () => ({ error, stage: 'configuration_validation' }))
    throw error
  }
  if (!baseConfiguration) {
    debug.event('init.failed', () => ({
      reason: 'invalid_configuration',
      clientTokenPresent: !!initConfiguration.clientToken,
      validationIssues: configurationIssues(initConfiguration),
    }))
    return
  }
  debug.event('init.effective_configuration', () => ({
    site: baseConfiguration.site,
    env: baseConfiguration.env,
    service: baseConfiguration.service,
    applicationId: initConfiguration.applicationId,
    evaluationIntervalMs: initConfiguration.flagEvaluationTrackingInterval ?? 10000,
    defaults: {
      site: initConfiguration.site == null || initConfiguration.site === '',
      evaluationInterval: initConfiguration.flagEvaluationTrackingInterval == null,
    },
    trackingRoutes:
      typeof initConfiguration.proxy === 'function'
        ? { resolution: 'at_send', reason: 'custom_proxy_callback' }
        : {
            exposure: initConfiguration.proxy
              ? { proxy: debugUrl(initConfiguration.proxy), path: '/api/v2/exposures' }
              : `https://${buildEndpointHost({ clientToken: '', site: baseConfiguration.site })}/api/v2/exposures`,
            evaluation: initConfiguration.proxy
              ? { proxy: debugUrl(initConfiguration.proxy), path: '/api/v2/flagevaluation' }
              : `https://${buildEndpointHost({ clientToken: '', site: baseConfiguration.site })}/api/v2/flagevaluation`,
          },
    openFeatureVersion: 'not_exposed_by_runtime_api',
    registration: 'application_managed; client/domain observed on evaluation',
  }))

  return {
    applicationId: initConfiguration.applicationId,
    flagEvaluationTrackingInterval: initConfiguration.flagEvaluationTrackingInterval ?? 10000,
    ...baseConfiguration,
    debug,
  }
}

export function validateAndBuildFlaggingConfiguration(
  initConfiguration: FlaggingInitConfiguration,
  debug = createDebugLogger(initConfiguration.debugMode)
): FlaggingConfiguration | undefined {
  const trackingConfiguration = validateAndBuildFlaggingTrackingConfiguration(initConfiguration, debug)
  if (!trackingConfiguration) {
    // Invalid ordinary configuration must never erase a requested required-signing policy.
    if (initConfiguration.responseSigning?.mode === 'required')
      throw new Error('Required response signing needs valid provider configuration')
    return
  }

  const snapshot =
    initConfiguration.responseSigning && initConfiguration.responseSigning.mode !== 'off'
      ? { ...initConfiguration, customHeaders: { ...initConfiguration.customHeaders } }
      : initConfiguration
  const responseSigning = createResponseSigningController(
    initConfiguration.responseSigning,
    {
      clientToken: snapshot.clientToken,
      applicationId: snapshot.applicationId,
      env: snapshot.env,
      site: snapshot.site,
      flaggingProxy: snapshot.flaggingProxy,
      customHeaders: snapshot.customHeaders,
      overwriteRequestHeaders: snapshot.overwriteRequestHeaders,
      flagSelection: snapshot.flagSelection,
    },
    debug
  )
  return {
    responseSigning,
    fetchFlagsConfiguration: createFlagsConfigurationFetcher(snapshot, responseSigning, debug),
    ...trackingConfiguration,
  }
}

/** Explain ordinary validation failures using data properties only; never re-read user accessors. */
function configurationIssues(options: object): Array<{ field: string; reason: string; value?: unknown }> {
  const descriptors = Object.getOwnPropertyDescriptors(options)
  const value = (key: string) => descriptors[key]?.value
  const issues: Array<{ field: string; reason: string; value?: unknown }> = []
  if (!value('clientToken')) issues.push({ field: 'clientToken', reason: 'required_credential_missing_or_accessor' })
  for (const field of ['env', 'service', 'version']) {
    const raw = value(field)
    if (raw != null && typeof raw !== 'string') issues.push({ field, reason: 'expected_string', value: raw })
  }
  for (const field of [
    'sessionSampleRate',
    'telemetrySampleRate',
    'telemetryConfigurationSampleRate',
    'telemetryUsageSampleRate',
  ]) {
    const raw = value(field)
    if (raw !== undefined && (typeof raw !== 'number' || !(raw >= 0 && raw <= 100)))
      issues.push({ field, reason: 'expected_percentage_0_to_100', value: raw })
  }
  const site = value('site')
  if (site && typeof site === 'string' && !/(datadog|ddog|datad0g|dd0g)/.test(site))
    issues.push({ field: 'site', reason: 'unsupported_site', value: site })
  const consent = value('trackingConsent')
  if (consent !== undefined && consent !== 'granted' && consent !== 'not-granted')
    issues.push({ field: 'trackingConsent', reason: 'expected_granted_or_not_granted', value: consent })
  const origins = value('allowedTrackingOrigins')
  if (origins !== undefined)
    issues.push({
      field: 'allowedTrackingOrigins',
      reason: Array.isArray(origins) ? 'check_origin_and_proxy_validation' : 'expected_array',
      value: origins,
    })
  if (!issues.length)
    issues.push({ field: 'configuration', reason: 'shared_core_rejected; see_validation_console_error' })
  return issues
}
