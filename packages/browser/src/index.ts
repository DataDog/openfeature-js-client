import { defineGlobal, getGlobalObject } from '@datadog/browser-core'
import { DatadogProvider } from './openfeature/provider'

export type { FlaggingInitConfiguration } from './domain/configuration'
export { DatadogDevtools } from './openfeature/devtools-provider'
export { DatadogProvider }

// Build environment placeholder for testing
const _SDK_VERSION = __BUILD_ENV__SDK_VERSION__

defineGlobal(getGlobalObject(), 'DD_FLAGGING' as keyof typeof globalThis, { Provider: DatadogProvider })
