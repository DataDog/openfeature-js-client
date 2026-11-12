export type { FlagSelection, FlagsConfiguration } from '@datadog/flagging-core'
export {
  ConfigurationPrecomputeError,
  type ConfigurationPrecomputeErrorCode,
  configurationFromRulesBinary,
  configurationFromString,
  configurationToString,
  type FlagsConfigurationWire,
  type PrecomputeConfigurationOptions,
  type PrecomputeEvaluationError,
  precomputeConfiguration,
} from '@datadog/flagging-core/rules-based'
export * from './configuration/fetch-rules-configuration'
export { DatadogCoreProvider, type DatadogCoreProviderOptions } from './core-provider'
export { ExperimentationOptOutMode } from './experimentation-opt-out'
export { createExposureTracking } from './exposure-tracking'
