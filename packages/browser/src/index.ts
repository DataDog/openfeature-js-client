import { defineGlobal, getGlobalObject } from '@datadog/browser-core'
import { DatadogProvider } from './openfeature/provider'

export { DatadogProvider }
export { configurationFromString, configurationToString } from '@datadog/flagging-core'

// Build environment placeholder for testing
const SDK_VERSION = __BUILD_ENV__SDK_VERSION__

defineGlobal(getGlobalObject(), 'DD_FLAGGING' as keyof typeof globalThis, { Provider: DatadogProvider })
