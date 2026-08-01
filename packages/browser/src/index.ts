export type { FlagsConfigurationWire } from './configuration'
export { configurationFromString, configurationToString } from './configuration'

import { registerGlobal } from './register-global'

registerGlobal()

export * from './provider-entrypoint'
