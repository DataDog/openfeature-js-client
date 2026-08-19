import { registerGlobal } from './register-global'

registerGlobal()

export type { FlagsConfigurationWire } from '@datadog/flagging-core/rules-based'
export { configurationFromString, configurationToString } from '@datadog/flagging-core/rules-based'
export * from './provider-entrypoint'
