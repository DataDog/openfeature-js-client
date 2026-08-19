import { getGlobalObject, INTAKE_SITE_STAGING } from '@datadog/browser-core'
import { OpenFeature } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { DatadogProvider } from '../../src/openfeature/provider'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import precomputedResponse from '../data/precomputed-v1.json'

type CapturedLifecycleEvent = {
  telemetry: Record<string, unknown> & {
    event_type: string
    runtime_id: string
  }
}

describe('Feature Flags lifecycle telemetry', () => {
  let fetchMock: jest.Mock
  let originalFetch: typeof global.fetch

  const providerConfiguration: FlaggingInitConfiguration = {
    clientToken: 'test-client-token',
    applicationId: 'test-application-id',
    service: 'test-service',
    env: 'test',
    site: INTAKE_SITE_STAGING,
    enableExposureLogging: false,
    enableFlagEvaluationTracking: false,
    enableRumFeatureFlagTracking: false,
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
    delete getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM
    localStorage.clear()
    jest.setSystemTime(new Date('2026-08-19T12:00:00.000Z'))

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('precompute-assignments')) {
        return Promise.resolve({
          ok: true,
          headers: { get: jest.fn() },
          json: () => Promise.resolve(precomputedResponse),
        })
      }
      return Promise.resolve({ ok: true, status: 202 })
    })
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
    jest.clearAllTimers()
  })

  it('emits each onboarding transition once through the RUM telemetry intake', async () => {
    await OpenFeature.setContext({ targetingKey: 'test-user', email: 'user@example.com' })
    await OpenFeature.setProviderAndWait(new DatadogProvider(providerConfiguration))

    const client = OpenFeature.getClient()
    expect(client.getStringValue('string-flag', 'default')).toBe('red')
    expect(client.getStringValue('string-flag', 'default')).toBe('red')

    jest.advanceTimersByTime(30_000)

    const rumCalls = fetchMock.mock.calls.filter(([url]) => url.toString().includes('/api/v2/rum'))
    expect(rumCalls).toHaveLength(1)

    const [url, request] = rumCalls[0]
    expect(url.toString()).toContain('dd-api-key=test-client-token')

    const events: CapturedLifecycleEvent[] = request.body
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line) as CapturedLifecycleEvent)

    expect(events).toHaveLength(3)
    expect(events.map((event) => event.telemetry.event_type)).toEqual([
      'sdk_init_started',
      'configuration_received',
      'first_evaluation',
    ])

    const runtimeIds = new Set(events.map((event) => event.telemetry.runtime_id))
    expect(runtimeIds.size).toBe(1)
    expect([...runtimeIds][0]).toMatch(/^[0-9a-f-]{36}$/)

    events.forEach((event) => {
      expect(event).toMatchObject({
        type: 'telemetry',
        service: 'browser-feature-flags-sdk',
        version: '1.0.0-test',
        source: 'browser',
        _dd: { format_version: 2 },
        telemetry: {
          type: 'log',
          status: 'debug',
          message: 'Feature Flags SDK lifecycle',
          product: 'feature_flags',
          application_id: 'test-application-id',
          service: 'test-service',
          environment: 'test',
          sdk_name: 'dd-openfeature-browser',
          sdk_version: '1.0.0-test',
        },
      })
    })

    expect(events[0].telemetry.provider_status).toBe('not_ready')
    expect(events[1].telemetry).toMatchObject({
      configuration_source: 'remote',
      configuration_version: '1731939805123',
      configuration_fetched_at: new Date('2026-08-19T12:00:00.000Z').getTime(),
    })
    expect(events[2].telemetry.provider_status).toBe('ready')

    const serializedEvents = JSON.stringify(events)
    expect(serializedEvents).not.toContain('org_id')
    expect(serializedEvents).not.toContain('targeting_key')
    expect(serializedEvents).not.toContain('test-user')
    expect(serializedEvents).not.toContain('user@example.com')
  })
})
