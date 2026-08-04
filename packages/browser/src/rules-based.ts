import { registerGlobal } from './register-global'

registerGlobal()

export type { FlagsConfigurationWire } from '@datadog/flagging-core/rules-based'
export {
  configurationFromString,
  configurationToString,
  getPrecomputedContext,
} from '@datadog/flagging-core/rules-based'
export * from './provider-entrypoint'
export type {
  ConfigurationFetchOptions,
  PrecomputedConfigurationFetchOptions,
  RulesConfigurationFetchOptions,
} from './transport/fetchConfiguration'
export { fetchPrecomputedConfiguration } from './transport/fetchConfiguration'
export { fetchRulesConfiguration } from './transport/fetchRulesConfiguration'
