import { registerGlobal } from './register-global'

registerGlobal()

export type { FlagsConfigurationWire } from '@datadog/flagging-core'
export { configurationFromString, configurationToString, getPrecomputedContext } from '@datadog/flagging-core'
export * from './provider-entrypoint'
export { withRetry, withTimeout } from './transport/fetch'
