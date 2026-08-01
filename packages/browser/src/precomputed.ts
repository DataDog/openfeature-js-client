import { registerGlobal } from './register-global'

registerGlobal()

export type { FlagsConfigurationWire } from '@datadog/flagging-core/precomputed'
export { configurationFromString, configurationToString } from '@datadog/flagging-core/precomputed'
export * from './provider-entrypoint'
