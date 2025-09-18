import { OpenFeature } from '@openfeature/web-sdk'
import { INTAKE_SITE_STAGING } from '@datadog/browser-core'
import { DatadogProvider } from '../../src/openfeature/provider'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import precomputedServerResponse from '../data/precomputed-v1.json'

describe('Exposures End-to-End', () => {
  let fetchMock: jest.Mock
  let originalFetch: typeof global.fetch

  // Test helpers
  const getExposuresCalls = () => fetchMock.mock.calls.filter(([url]) => url.toString().includes('exposures'))
  const parseExposureEvents = (body: string) =>
    body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  const triggerBatch = () => jest.advanceTimersByTime(31000)

  const baseProviderConfig = {
    clientToken: 'test-client-token',
    applicationId: 'test-app-id',
    env: 'test',
    site: INTAKE_SITE_STAGING,
  }

  beforeAll(() => {
    originalFetch = global.fetch
    fetchMock = jest.fn()
    global.fetch = fetchMock
    jest.useFakeTimers()
  })

  afterAll(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
  })

  beforeEach(() => {
    fetchMock.mockClear()
    OpenFeature.clearProviders()
    // Mock current time to get deterministic timestamps
    jest.setSystemTime(new Date('2025-08-04T17:00:00.000Z'))
  })

  it('should send exposure events to correct endpoint with proper payload', async () => {
    // Mock server responses
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('exposures')) {
        // Mock exposures batch endpoint
        return Promise.resolve({
          ok: true,
          status: 200,
        })
      }
      if (url.includes('precompute-assignments')) {
        // Mock flag configuration endpoint
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(precomputedServerResponse),
        })
      }
      // Fallback for any other requests
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      })
    })

    // Initialize provider without initial config - will fetch from server
    const providerConfig: FlaggingInitConfiguration = {
      ...baseProviderConfig,
      service: 'test-service',
      version: '1.0.0',
      enableExposureLogging: true,
    }

    // Set evaluation context
    await OpenFeature.setContext({
      targetingKey: 'test-user-123',
      customAttribute: 'test-value',
    })

    // Wait for provider to initialize and fetch configuration
    const provider = new DatadogProvider(providerConfig)
    await OpenFeature.setProviderAndWait(provider)

    // Evaluate two flags that should generate exposure events
    const client = OpenFeature.getClient()

    const stringResult = await client.getStringValue('string-flag', 'default')
    const booleanResult = await client.getBooleanValue('boolean-flag', false)

    // Verify flag evaluations worked
    expect(stringResult).toBe('red')
    expect(booleanResult).toBe(true)

    // Trigger exposure batching using fake timers
    triggerBatch()

    const exposuresCalls = getExposuresCalls()

    expect(exposuresCalls).toHaveLength(1)

    const [exposuresUrl, exposuresRequest] = exposuresCalls[0]

    // Verify endpoint URL pattern (request ID and version are dynamic)
    expect(exposuresUrl.toString()).toMatch(
      /^https:\/\/browser-intake-datad0g\.com\/api\/v2\/exposures\?ddsource=browser&dd-api-key=test-client-token&dd-evp-origin-version=\d+\.\d+\.\d+&dd-evp-origin=browser&dd-request-id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )

    // Verify exact request properties
    expect(exposuresRequest).toMatchObject({
      method: 'POST',
      mode: 'cors',
    })

    // Parse and verify payload (newline-delimited JSON)
    const exposureEvents = parseExposureEvents(exposuresRequest.body)

    // Expected exposure events (order matches evaluation order)
    const expectedEvents = [
      {
        timestamp: new Date('2025-08-04T17:00:00.000Z').getTime(),
        allocation: { key: 'allocation-123' },
        flag: { key: 'string-flag' },
        variant: { key: 'variation-123' },
        subject: {
          id: 'test-user-123',
          attributes: { customAttribute: 'test-value' },
        },
      },
      {
        timestamp: new Date('2025-08-04T17:00:00.000Z').getTime(),
        allocation: { key: 'allocation-124' },
        flag: { key: 'boolean-flag' },
        variant: { key: 'variation-124' },
        subject: {
          id: 'test-user-123',
          attributes: { customAttribute: 'test-value' },
        },
      },
    ]

    expect(exposureEvents).toEqual(expectedEvents)
  })

  it('should not send exposure events when exposure logging is disabled', async () => {
    // Mock server response
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('precompute-assignments')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(precomputedServerResponse),
        })
      }
      return Promise.resolve({ ok: true })
    })

    // Initialize provider without exposure logging
    const providerConfig: FlaggingInitConfiguration = {
      ...baseProviderConfig,
      enableExposureLogging: false, // Disabled
    }

    const provider = new DatadogProvider(providerConfig)
    await OpenFeature.setProviderAndWait(provider)

    // Evaluate flags
    const client = OpenFeature.getClient()
    await client.getStringValue('string-flag', 'default')
    await client.getBooleanValue('boolean-flag', false)

    // Trigger (potential) batch timeout
    triggerBatch()

    // Verify no exposures requests were made
    const exposuresCalls = getExposuresCalls()

    expect(exposuresCalls).toHaveLength(0)
  })

  it('should not send exposure events for flags with doLog: false', async () => {
    // Create modified mock data with doLog: false for one flag
    const modifiedServerResponse = {
      ...precomputedServerResponse,
      data: {
        ...precomputedServerResponse.data,
        attributes: {
          ...precomputedServerResponse.data.attributes,
          flags: {
            'string-flag': {
              ...precomputedServerResponse.data.attributes.flags['string-flag'],
              doLog: false, // Should not log
            },
            'boolean-flag': {
              ...precomputedServerResponse.data.attributes.flags['boolean-flag'],
              doLog: true, // Should log
            },
          },
        },
      },
    }

    // Mock server with modified response
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('exposures')) {
        return Promise.resolve({ ok: true, status: 200 })
      }
      if (url.includes('precompute-assignments')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(modifiedServerResponse),
        })
      }
      return Promise.resolve({ ok: true })
    })

    const providerConfig: FlaggingInitConfiguration = {
      ...baseProviderConfig,
      enableExposureLogging: true,
    }

    const provider = new DatadogProvider(providerConfig)
    await OpenFeature.setContext({ targetingKey: 'test-user-123' })
    await OpenFeature.setProviderAndWait(provider)

    // Evaluate both flags
    const client = OpenFeature.getClient()
    await client.getStringValue('string-flag', 'default')
    await client.getBooleanValue('boolean-flag', false)

    // Trigger batch timeout
    triggerBatch()

    // Should only have one exposure event (for boolean-flag)
    const exposuresCalls = getExposuresCalls()

    if (exposuresCalls.length > 0) {
      const exposureEvents = parseExposureEvents(exposuresCalls[0][1].body)
      const expectedEvents = [
        {
          timestamp: new Date('2025-08-04T17:00:00.000Z').getTime(),
          allocation: { key: 'allocation-124' },
          flag: { key: 'boolean-flag' },
          variant: { key: 'variation-124' },
          subject: {
            id: 'test-user-123',
            attributes: {},
          },
        },
      ]

      expect(exposureEvents).toEqual(expectedEvents)
    }
  })
})
