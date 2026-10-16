export type { FlagsConfiguration } from '@datadog/flagging-core'
export {
  configurationFromRulesBinary,
  configurationFromString,
  configurationToString,
  type FlagsConfigurationWire,
} from '@datadog/flagging-core/rules-based'
export * from './configuration/fetch-rules-configuration'
