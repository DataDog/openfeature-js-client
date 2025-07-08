import { DatadogProvider } from './openfeature/provider'

export { DatadogProvider }
export { configurationFromString, configurationToString } from '@datadog/flagging-core'

interface BrowserWindow extends Window {
  DD_FLAGGING?: {
    Provider: typeof DatadogProvider
  }
}

// Conditionally integrate with @datadog/browser-core if available
;(async () => {
  try {
    const browserCore = await import('@datadog/browser-core')
    browserCore.defineGlobal(browserCore.getGlobalObject(), 'DD_FLAGGING' as keyof typeof globalThis, { Provider: DatadogProvider })
  } catch (error) {
    // @datadog/browser-core not available, skip global registration
    // This is expected when the library is used without the RUM integration
  }
})()
