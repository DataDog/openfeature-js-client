export type { ClientCompatibility, FlagsConfiguration, FlagsConfigurationWire } from '@datadog/flagging-core'
export { configurationFromString, configurationToString, getPrecomputedContext } from '@datadog/flagging-core'
export { ConfigurationFetchError, type ConfigurationFetchErrorCode } from './configuration/configuration-fetch'
export {
  fetchPrecomputedConfiguration,
  type PrecomputedConfigurationFetchOptions,
} from './configuration/fetch-precomputed-configuration'
export type { UniversalFlagConfigurationV1 } from './configuration/ufc-v1'
export { ExperimentationOptOutMode } from './experimentation-opt-out'
export * from './provider'

// Build environment placeholder for testing
const _SDK_VERSION = __BUILD_ENV__SDK_VERSION__
