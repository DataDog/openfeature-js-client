import { defineGlobal, getGlobalObject } from '@datadog/browser-core'
import { DatadogProvider } from './openfeature/provider'

// Build environment placeholder for testing
const _SDK_VERSION = __BUILD_ENV__SDK_VERSION__

export function registerGlobal(): void {
  defineGlobal(getGlobalObject(), 'DD_FLAGGING' as keyof typeof globalThis, { Provider: DatadogProvider })
}
