import { defineGlobal, getGlobalObject } from '@datadog/browser-core'
import { DatadogOfflineProvider } from './openfeature/offline-provider'
import { DatadogProvider } from './openfeature/provider'
import { enrichRumContext } from './openfeature/rumIntegration'

// Build environment placeholder for testing
const _SDK_VERSION = __BUILD_ENV__SDK_VERSION__

export function registerRulesBasedGlobal(): void {
  defineGlobal(getGlobalObject(), 'DD_FLAGGING' as keyof typeof globalThis, {
    Provider: DatadogProvider,
    OfflineProvider: DatadogOfflineProvider,
    enrichRumContext,
  })
}
