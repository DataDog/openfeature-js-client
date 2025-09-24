import { ProviderStatus } from '@openfeature/server-sdk'
import { DatadogNodeServerProvider } from '../src/provider'

describe('DatadogNodeServerProvider', () => {
  const mockConfiguration = {} as any
  const mockExposureChannel = {} as any

  it('should should be ready when configuration is provided', () => {
    const provider = new DatadogNodeServerProvider({
      configuration: mockConfiguration,
      exposureChannel: mockExposureChannel,
    })
    expect(provider.status).toBe(ProviderStatus.READY)
  })

  it('should should be not ready when configuration is not provided', () => {
    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
    })
    expect(provider.status).toBe(ProviderStatus.NOT_READY)
  })

  it('should be ready when configuration is set', () => {
    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
    })
    expect(provider.status).toBe(ProviderStatus.NOT_READY)
    provider.setConfiguration(mockConfiguration)
    expect(provider.status).toBe(ProviderStatus.READY)
  })

  it('should be not ready when configuration is set to undefined', () => {
    const provider = new DatadogNodeServerProvider({
      configuration: mockConfiguration,
      exposureChannel: mockExposureChannel,
    })
    expect(provider.status).toBe(ProviderStatus.READY)
    provider.setConfiguration(undefined as any)
    expect(provider.status).toBe(ProviderStatus.NOT_READY)
  })
})
