import { defineGlobal, getGlobalObject } from '@datadog/browser-core'
import { DatadogCoreProvider } from './openfeature/core-provider'
import { DatadogProvider } from './openfeature/provider'

// Build environment placeholder for testing
const _SDK_VERSION = __BUILD_ENV__SDK_VERSION__

export function registerRulesBasedGlobal(): void {
  defineGlobal(getGlobalObject(), 'DD_FLAGGING' as keyof typeof globalThis, {
    Provider: DatadogProvider,
    CoreProvider: DatadogCoreProvider,
  })
}
