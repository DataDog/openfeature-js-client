export type { ClientFingerprint, FlagSelection, FlagsConfiguration } from '@datadog/flagging-core'
export {
  ConfigurationPrecomputeError,
  type ConfigurationPrecomputeErrorCode,
  configurationFromRulesBinary,
  configurationFromString,
  configurationToString,
  type FlagsConfigurationWire,
  type PrecomputeEvaluationError,
} from '@datadog/flagging-core/rules-based'
export {
  fetchPrecomputedConfiguration,
  type PrecomputedConfigurationFetchOptions,
} from './configuration/fetch-precomputed-configuration'
export * from './configuration/fetch-rules-configuration'
export { type PrecomputeConfigurationOptions, precomputeConfiguration } from './configuration/precompute-configuration'
export { DatadogCoreProvider, type DatadogCoreProviderOptions } from './core-provider'
export { ExperimentationOptOutMode } from './experimentation-opt-out'
