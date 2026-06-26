import { defineGlobal, getGlobalObject } from '@datadog/browser-core'
import { DatadogProvider } from './openfeature/provider'

export { configurationFromString, configurationToString } from '@datadog/flagging-core'
export type { FlaggingInitConfiguration } from './domain/configuration'
export type { InitFeatureFlagsOptions } from './init'
export { initFeatureFlags } from './init'
export { DevToolsProvider } from './openfeature/devtools-provider'
export { DatadogProvider }

// Build environment placeholder for testing
const _SDK_VERSION = __BUILD_ENV__SDK_VERSION__

defineGlobal(getGlobalObject(), 'DD_FLAGGING' as keyof typeof globalThis, { Provider: DatadogProvider })
