export type { ClientCompatibility, FlagSelection, FlagsConfiguration } from '@datadog/flagging-core'
export {
  ConfigurationPrecomputeError,
  type ConfigurationPrecomputeErrorCode,
  configurationFromRulesBinary,
  configurationFromString,
  configurationToString,
  type FlagsConfigurationWire,
  type PrecomputeEvaluationError,
} from '@datadog/flagging-core/rules-based'
export * from './configuration/fetch-rules-configuration'
export { type PrecomputeConfigurationOptions, precomputeConfiguration } from './configuration/precompute-configuration'
