export type { FlagsConfigurationWire } from './configuration'
export { configurationFromString, configurationToString } from './configuration'
export type {
  ConfigurationFetchOptions,
  PrecomputedConfigurationFetchOptions,
  RulesConfigurationFetchOptions,
} from './transport/fetchConfiguration'
export { fetchPrecomputedConfiguration } from './transport/fetchConfiguration'
export { fetchRulesConfiguration } from './transport/fetchRulesConfiguration'

import { registerGlobal } from './register-global'

registerGlobal()

export * from './provider-entrypoint'
