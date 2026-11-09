import { registerGlobal } from './register-global'

export { getPrecomputedClientCompatibility } from './precomputed-client-compatibility'
export type { PrecomputedConfigurationFetchOptions } from './transport/fetchConfiguration'
export { fetchPrecomputedConfiguration } from './transport/fetchConfiguration'

registerGlobal()

export type { FlagsConfigurationWire, PrecomputedClientCompatibility } from '@datadog/flagging-core'
export { configurationFromString, configurationToString, getPrecomputedContext } from '@datadog/flagging-core'
export * from './provider-entrypoint'
export { withRetry, withTimeout } from './transport/fetch'
