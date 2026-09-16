import { registerRulesBasedGlobal } from './register-rules-based-global'

registerRulesBasedGlobal()

export type { FlagsConfigurationWire } from '@datadog/flagging-core/rules-based'
export {
  configurationFromString,
  configurationToString,
  getPrecomputedContext,
} from '@datadog/flagging-core/rules-based'
export { DatadogCoreProvider } from './openfeature/core-provider'
export * from './provider-entrypoint'
export type {
  PrecomputedConfigurationFetchOptions,
  RulesConfigurationFetchOptions,
} from './transport/fetchConfiguration'
export { fetchPrecomputedConfiguration } from './transport/fetchConfiguration'
export { fetchRulesConfiguration } from './transport/fetchRulesConfiguration'
