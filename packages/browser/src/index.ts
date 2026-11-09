import { registerGlobal } from './register-global'

export { getClientCompatibility } from './client-compatibility'
export type { PrecomputedConfigurationFetchOptions } from './transport/fetchConfiguration'
export { fetchPrecomputedConfiguration } from './transport/fetchConfiguration'

registerGlobal()

export type { ClientCompatibility, FlagsConfigurationWire } from '@datadog/flagging-core'
export { configurationFromString, configurationToString, getPrecomputedContext } from '@datadog/flagging-core'
export * from './provider-entrypoint'
export { withRetry, withTimeout } from './transport/fetch'
