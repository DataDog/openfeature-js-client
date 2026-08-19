import { registerGlobal } from './register-global'

export type { ConfigurationFetchOptions, PrecomputedConfigurationFetchOptions } from './transport/fetchConfiguration'
export { fetchPrecomputedConfiguration } from './transport/fetchConfiguration'

registerGlobal()

export type { FlagsConfigurationWire } from '@datadog/flagging-core'
export { configurationFromString, configurationToString, getPrecomputedContext } from '@datadog/flagging-core'
export * from './provider-entrypoint'
