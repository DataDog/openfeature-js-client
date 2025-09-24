import { ProviderStatus } from '@openfeature/server-sdk'
import { DatadogNodeServerProvider } from '../src/provider'
import { UniversalFlagConfigurationV1, UniversalFlagConfigurationV1Response } from 'src/configuration/ufc-v1'
import fs from 'fs'
import path from 'path'
import { Channel } from 'diagnostics_channel'
import { ExposureEvent } from '@datadog/flagging-core/src/configuration/exposureEvent.types'

describe('DatadogNodeServerProvider', () => {
  const mockExposureChannel: Channel<ExposureEvent, ExposureEvent> = {
    hasSubscribers: true,
    publish: jest.fn(),
    subscribe: jest.fn(),
  } as unknown as Channel<ExposureEvent, ExposureEvent>

  const configuration = ((): UniversalFlagConfigurationV1 => {
    const ufcJson = fs.readFileSync(path.join(__dirname, './data', 'flags-v1.json'), 'utf8')
    const ufcResponse = JSON.parse(ufcJson) as UniversalFlagConfigurationV1Response
    return ufcResponse.data.attributes
  })()

  it('should should be ready when configuration is provided', () => {
    const provider = new DatadogNodeServerProvider({
      configuration: configuration,
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
    provider.setConfiguration(configuration)
    expect(provider.status).toBe(ProviderStatus.READY)
  })

  it('should be not ready when configuration is set to undefined', () => {
    const provider = new DatadogNodeServerProvider({
      configuration: configuration,
      exposureChannel: mockExposureChannel,
    })
    expect(provider.status).toBe(ProviderStatus.READY)
    provider.setConfiguration(undefined)
    expect(provider.status).toBe(ProviderStatus.NOT_READY)
  })
})
