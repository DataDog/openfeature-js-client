import { INTAKE_SITE_STAGING } from '@datadog/browser-core'
import { OpenFeature } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { DatadogProvider } from '../../src/openfeature/provider'
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

  beforeEach(async () => {
    fetchMock.mockReset()
    await OpenFeature.clearProviders()
    await OpenFeature.clearContext()
    OpenFeature.clearHandlers()
    OpenFeature.clearHooks()

    // Clear localStorage to reset assignment cache between tests
    localStorage.clear()

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

    const stringResult = client.getStringValue('string-flag', 'default')
    const booleanResult = client.getBooleanValue('boolean-flag', false)

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
        application: { id: 'test-app-id' },
        service: 'test-service',
        view: { url: 'http://localhost/' },
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
        application: { id: 'test-app-id' },
        service: 'test-service',
        view: { url: 'http://localhost/' },
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
    client.getStringValue('string-flag', 'default')
    client.getBooleanValue('boolean-flag', false)

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
    client.getStringValue('string-flag', 'default')
    client.getBooleanValue('boolean-flag', false)

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
          application: { id: 'test-app-id' },
          view: { url: 'http://localhost/' },
        },
      ]

      expect(exposureEvents).toEqual(expectedEvents)
    }
  })

  describe('exposure logging deduplication', () => {
    let providerConfig: FlaggingInitConfiguration

    beforeEach(async () => {
      providerConfig = {
        ...baseProviderConfig,
        service: 'test-service',
        version: '1.0.0',
        enableExposureLogging: true,
      }
      // Additional cleanup to ensure fresh state
      fetchMock.mockReset()
      await OpenFeature.clearProviders()
      await OpenFeature.clearContext()
      OpenFeature.clearHandlers()
      OpenFeature.clearHooks()

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
    })

    it('does not log duplicate exposure events', async () => {
      // Set context before provider initialization
      await OpenFeature.setContext({
        targetingKey: 'test-user-123',
        customAttribute: 'test-value',
      })

      // Wait for provider to initialize and fetch configuration
      const provider = new DatadogProvider(providerConfig)
      await OpenFeature.setProviderAndWait(provider)
      const client = OpenFeature.getClient()

      client.getStringValue('string-flag', 'default')
      triggerBatch()

      client.getStringValue('string-flag', 'default')
      triggerBatch()

      expect(getExposuresCalls()).toHaveLength(1)
    })

    it('logs duplicate assignments on context change', async () => {
      // Set context before provider initialization
      await OpenFeature.setContext({
        targetingKey: 'test-user-123',
        customAttribute: 'test-value',
      })

      // Wait for provider to initialize and fetch configuration
      const provider = new DatadogProvider(providerConfig)
      await OpenFeature.setProviderAndWait(provider)
      const client = OpenFeature.getClient()

      // with original context
      client.getStringValue('string-flag', 'default')
      triggerBatch()

      // with new context
      await OpenFeature.setContext({
        targetingKey: 'test-user-123',
        customAttribute: 'test-value-2',
      })
      client.getStringValue('string-flag', 'default')
      triggerBatch()

      expect(getExposuresCalls()).toHaveLength(2)
    })

    it('logs for each unique flag', async () => {
      // Set context before provider initialization
      await OpenFeature.setContext({
        targetingKey: 'test-user-123',
        customAttribute: 'test-value',
      })

      const provider = new DatadogProvider(providerConfig)
      await OpenFeature.setProviderAndWait(provider)
      const client = OpenFeature.getClient()

      // Evaluate three different flags multiple times each
      client.getStringValue('string-flag', 'default')
      client.getStringValue('string-flag', 'default')
      client.getBooleanValue('boolean-flag', false)
      client.getBooleanValue('boolean-flag', false)
      client.getNumberValue('integer-flag', 0)
      client.getNumberValue('integer-flag', 0)
      client.getStringValue('string-flag', 'default')
      client.getBooleanValue('boolean-flag', false)
      client.getNumberValue('integer-flag', 0)

      // Trigger batch once after all evaluations
      triggerBatch()

      // Should only have 1 exposure call
      const exposuresCalls = getExposuresCalls()
      expect(exposuresCalls).toHaveLength(1)

      // Parse the exposure events
      const exposureEvents = parseExposureEvents(exposuresCalls[0][1].body)

      // Should only have 3 events (one per unique flag), not 9
      expect(exposureEvents).toHaveLength(3)

      // Verify we have one event for each flag
      const flagKeys = exposureEvents.map((event) => event.flag.key)
      expect(flagKeys).toContain('string-flag')
      expect(flagKeys).toContain('boolean-flag')
      expect(flagKeys).toContain('integer-flag')
    })

    it('logs twice for the same flag when variation change', async () => {
      // Create two different server responses with different variations
      const firstResponse = {
        ...precomputedServerResponse,
        data: {
          ...precomputedServerResponse.data,
          attributes: {
            ...precomputedServerResponse.data.attributes,
            flags: {
              'string-flag': {
                allocationKey: 'allocation-123',
                variationKey: 'variation-a',
                variationType: 'STRING',
                variationValue: 'red',
                extraLogging: {},
                doLog: true,
                reason: 'TARGETING_MATCH',
              },
            },
          },
        },
      }

      const secondResponse = {
        ...precomputedServerResponse,
        data: {
          ...precomputedServerResponse.data,
          attributes: {
            ...precomputedServerResponse.data.attributes,
            flags: {
              'string-flag': {
                allocationKey: 'allocation-123',
                variationKey: 'variation-b',
                variationType: 'STRING',
                variationValue: 'blue',
                extraLogging: {},
                doLog: true,
                reason: 'TARGETING_MATCH',
              },
            },
          },
        },
      }

      let configFetchCount = 0

      // Mock fetch to return different configurations on subsequent fetches
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('exposures')) {
          return Promise.resolve({ ok: true, status: 200 })
        }
        if (url.includes('precompute-assignments')) {
          configFetchCount++
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(configFetchCount === 1 ? firstResponse : secondResponse),
          })
        }
        return Promise.resolve({ ok: true })
      })

      // Set context before provider initialization
      await OpenFeature.setContext({
        targetingKey: 'test-user-123',
        customAttribute: 'test-value',
      })

      // Initialize provider with first configuration
      const provider = new DatadogProvider(providerConfig)
      await OpenFeature.setProviderAndWait(provider)
      const client = OpenFeature.getClient()

      // Evaluate flag with first variation
      const firstValue = client.getStringValue('string-flag', 'default')
      expect(firstValue).toBe('red')
      triggerBatch()

      // Fetch new configuration (simulating a config update)
      // This would typically happen automatically via polling, but we trigger it manually
      await provider.onContextChange({}, { targetingKey: 'test-user-123', customAttribute: 'test-value' })

      // Evaluate same flag with second variation
      const secondValue = client.getStringValue('string-flag', 'default')
      expect(secondValue).toBe('blue')
      triggerBatch()

      // Should have 2 exposure calls (one for each variation)
      const exposuresCalls = getExposuresCalls()
      expect(exposuresCalls).toHaveLength(2)

      // Parse both exposure events
      const firstExposureEvents = parseExposureEvents(exposuresCalls[0][1].body)
      const secondExposureEvents = parseExposureEvents(exposuresCalls[1][1].body)

      // First exposure should have variation-a
      expect(firstExposureEvents[0].variant.key).toBe('variation-a')

      // Second exposure should have variation-b
      expect(secondExposureEvents[0].variant.key).toBe('variation-b')
    })

    it('should clear exposure cache when configuration createdAt changes', async () => {
      // Create two responses with different createdAt timestamps
      const firstResponse = {
        ...precomputedServerResponse,
        data: {
          ...precomputedServerResponse.data,
          attributes: {
            ...precomputedServerResponse.data.attributes,
            createdAt: 1731939805123,
          },
        },
      }

      const secondResponse = {
        ...precomputedServerResponse,
        data: {
          ...precomputedServerResponse.data,
          attributes: {
            ...precomputedServerResponse.data.attributes,
            createdAt: 1731939999999, // Different createdAt
          },
        },
      }

      let configFetchCount = 0

      // Mock fetch to return different configurations with different createdAt
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('exposures')) {
          return Promise.resolve({ ok: true, status: 200 })
        }
        if (url.includes('precompute-assignments')) {
          configFetchCount++
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(configFetchCount === 1 ? firstResponse : secondResponse),
          })
        }
        return Promise.resolve({ ok: true })
      })

      // Set context before provider initialization
      await OpenFeature.setContext({
        targetingKey: 'test-user-123',
        customAttribute: 'test-value',
      })

      // Initialize provider with first configuration
      const provider = new DatadogProvider(providerConfig)
      await OpenFeature.setProviderAndWait(provider)
      const client = OpenFeature.getClient()

      // Evaluate flag with first configuration
      client.getStringValue('string-flag', 'default')
      triggerBatch()

      // Verify first exposure was logged
      expect(getExposuresCalls()).toHaveLength(1)

      // Fetch new configuration with different createdAt (cache should be cleared)
      await provider.onContextChange({}, { targetingKey: 'test-user-123', customAttribute: 'test-value' })

      // Evaluate same flag - should log again because cache was cleared
      client.getStringValue('string-flag', 'default')
      triggerBatch()

      // Should have 2 exposure calls (cache was cleared)
      expect(getExposuresCalls()).toHaveLength(2)
    })

    it('should not clear exposure cache when configuration createdAt stays the same', async () => {
      // Create two responses with same createdAt
      const firstResponse = {
        ...precomputedServerResponse,
        data: {
          ...precomputedServerResponse.data,
          attributes: {
            ...precomputedServerResponse.data.attributes,
            createdAt: 1731939805123,
          },
        },
      }

      const secondResponse = {
        ...precomputedServerResponse,
        data: {
          ...precomputedServerResponse.data,
          attributes: {
            ...precomputedServerResponse.data.attributes,
            createdAt: 1731939805123, // Same createdAt
          },
        },
      }

      let configFetchCount = 0

      // Mock fetch to return configurations with same createdAt
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('exposures')) {
          return Promise.resolve({ ok: true, status: 200 })
        }
        if (url.includes('precompute-assignments')) {
          configFetchCount++
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(configFetchCount === 1 ? firstResponse : secondResponse),
          })
        }
        return Promise.resolve({ ok: true })
      })

      // Set context before provider initialization
      await OpenFeature.setContext({
        targetingKey: 'test-user-123',
        customAttribute: 'test-value',
      })

      // Initialize provider with first configuration
      const provider = new DatadogProvider(providerConfig)
      await OpenFeature.setProviderAndWait(provider)
      const client = OpenFeature.getClient()

      // Evaluate flag with first configuration
      client.getStringValue('string-flag', 'default')
      triggerBatch()

      // Verify first exposure was logged
      expect(getExposuresCalls()).toHaveLength(1)

      // Fetch new configuration with same createdAt (cache should NOT be cleared)
      await provider.onContextChange({}, { targetingKey: 'test-user-123', customAttribute: 'test-value' })

      // Evaluate same flag - should not log again because cache was not cleared
      client.getStringValue('string-flag', 'default')
      triggerBatch()

      // Should still have only 1 exposure call (cache was not cleared)
      expect(getExposuresCalls()).toHaveLength(1)
    })
  })
})
