import { DatadogOfflineProvider, DatadogProvider } from '../src/rules-based'

describe('rules-based entry point', () => {
  it('exports and registers rules-based browser APIs', () => {
    expect(DatadogProvider).toBeDefined()
    expect(DatadogOfflineProvider).toBeDefined()
    expect((globalThis as { DD_FLAGGING?: { OfflineProvider?: unknown } }).DD_FLAGGING?.OfflineProvider).toBe(
      DatadogOfflineProvider
    )
  })
})
