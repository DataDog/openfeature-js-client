import { defineGlobal } from '@datadog/browser-core'
import { globalObject } from '@datadog/js-core/util'
import { DatadogOfflineProvider } from './openfeature/offline-provider'
import { DatadogProvider } from './openfeature/provider'

// Build environment placeholder for testing
const _SDK_VERSION = __BUILD_ENV__SDK_VERSION__

export function registerRulesBasedGlobal(): void {
  defineGlobal(globalObject, 'DD_FLAGGING' as keyof typeof globalThis, {
    Provider: DatadogProvider,
    OfflineProvider: DatadogOfflineProvider,
  })
}
