import { registerRulesBasedGlobal } from './register-rules-based-global'

registerRulesBasedGlobal()

export type { FlagsConfigurationWire } from '@datadog/flagging-core/rules-based'
export {
  configurationFromString,
  configurationToString,
  getPrecomputedContext,
} from '@datadog/flagging-core/rules-based'
export { DatadogOfflineProvider } from './openfeature/offline-provider'
export * from './provider-entrypoint'
