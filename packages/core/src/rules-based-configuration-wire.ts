// Initialization belongs to the entrypoint, not a second list in the bundler configuration.
import './configuration/protobuf-text-encoding'

export { getPrecomputedContext } from './configuration/precomputed-context'
export { configurationFromRulesBinary } from './configuration/rules-wire'
export { configurationFromString, configurationToString } from './configuration/wire'
export type { FlagsConfigurationWire } from './configuration/wire-types'
