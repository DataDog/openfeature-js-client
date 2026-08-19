import { registerGlobal } from './register-global'

registerGlobal()

export type { FlagsConfigurationWire } from '@datadog/flagging-core'
export { configurationFromString, configurationToString } from '@datadog/flagging-core'
export * from './provider-entrypoint'
