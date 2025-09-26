
import type { FlagsConfiguration } from '@datadog/flagging-core'
import type {
  EvaluationContext,
  Hook,
  JsonValue,
  Logger,
  Paradigm,
  Provider,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/web-sdk'
/* eslint-disable-next-line local-rules/disallow-side-effects */
import { ProviderStatus } from '@openfeature/web-sdk'
import {
  type FlaggingConfiguration,
  type FlaggingInitConfiguration,
  validateAndBuildFlaggingConfiguration,
} from '../domain/configuration'
import { evaluate } from '../evaluation'
import { createExposureLoggingHook, createRumExposureHook, createRumTrackingHook } from './exposures'

/**
 * @deprecated Use FlaggingInitConfiguration instead
 */
export type DatadogProviderOptions = FlaggingInitConfiguration

// We need to use a class here to properly implement the OpenFeature Provider interface
// which requires class methods and properties. This is a valid exception to the no-classes rule.
/* eslint-disable-next-line no-restricted-syntax */
export class DatadogProvider implements Provider {
  readonly metadata: ProviderMetadata = {
    name: 'datadog',
  }
  readonly runsOn: Paradigm = 'client'
  hooks?: Hook[]

  status: ProviderStatus
  private flagsConfiguration: FlagsConfiguration = {}
  private configuration?: FlaggingConfiguration

  constructor(options: FlaggingInitConfiguration) {
    this.configuration = validateAndBuildFlaggingConfiguration(options)

    // Set up provider-managed hooks based on configuration
    this.hooks = []

    // Add RUM flag tracking hook (DEPRECATED)
    if (options.rum?.ddFlaggingTracking) {
      this.hooks.push(createRumTrackingHook(options.rum.sdk))
    }

    // Add RUM exposure logging hook (DEPRECATED)
    if (options.rum?.ddExposureLogging) {
      this.hooks.push(createRumExposureHook(options.rum.sdk))
    }

    // Add proper exposure logging hook (creates batch internally)
    if (options.enableExposureLogging && this.configuration) {
      this.hooks.push(createExposureLoggingHook(this.configuration))
    }

    if (options.initialFlagsConfiguration) {
      this.flagsConfiguration = options.initialFlagsConfiguration
      this.status = ProviderStatus.READY
    } else {
      this.flagsConfiguration = {}
      this.status = ProviderStatus.NOT_READY
    }
  }

  async initialize(context: EvaluationContext = {}): Promise<void> {
    if (!this.configuration) {
      throw new Error('Invalid configuration')
    }
    this.flagsConfiguration = await this.configuration.fetchFlagsConfiguration(context)
    this.status = ProviderStatus.READY
  }

  async onContextChange(_oldContext: EvaluationContext, context: EvaluationContext): Promise<void> {
    if (!this.configuration) {
      throw new Error('Invalid configuration')
    }
    this.status = ProviderStatus.RECONCILING
    this.flagsConfiguration = await this.configuration.fetchFlagsConfiguration(context)
    this.status = ProviderStatus.READY
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    _logger: Logger
  ): ResolutionDetails<boolean> {
    return evaluate(this.flagsConfiguration, 'boolean', flagKey, defaultValue, context)
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    _logger: Logger
  ): ResolutionDetails<string> {
    return evaluate(this.flagsConfiguration, 'string', flagKey, defaultValue, context)
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    _logger: Logger
  ): ResolutionDetails<number> {
    return evaluate(this.flagsConfiguration, 'number', flagKey, defaultValue, context)
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    _logger: Logger
  ): ResolutionDetails<T> {
    // type safety: OpenFeature interface requires us to return a
    // specific T for *any* value of T (which could be any subtype of
    // JsonValue). We can't even theoretically implement it in a
    // type-sound way because there's no runtime information passed to
    // learn what type the user expects. So it's up to the user to
    // make sure they pass the appropriate type.
    return evaluate(this.flagsConfiguration, 'object', flagKey, defaultValue, context) as ResolutionDetails<T>
  }
}
