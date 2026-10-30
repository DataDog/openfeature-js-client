import { TextEncoder } from 'node:util'
import { createHttpRequest, Observable, type PageMayExitEvent } from '@datadog/browser-core'
import { validateAndBuildFlaggingConfiguration } from '../../src/domain/configuration'
import { createLifecycleTelemetry } from '../../src/openfeature/lifecycleTelemetry'
import { diagnosticRecords } from './diagnostic-contract'

const mockSend = jest.fn()
const mockSendOnExit = jest.fn()
const mockExit = new Observable<PageMayExitEvent>()
jest.mock('@datadog/browser-core', () => ({
  ...jest.requireActual('@datadog/browser-core'),
  createHttpRequest: jest.fn(() => ({ send: mockSend, sendOnExit: mockSendOnExit })),
  createPageMayExitObservable: () => mockExit,
}))

function configuration() {
  const config = validateAndBuildFlaggingConfiguration({
    clientToken: 'secret-client-token',
    applicationId: 'app-1',
    env: 'staging',
  })
  if (!config) throw new Error('Invalid test configuration')
  return config
}
const records = () => mockSend.mock.calls.flatMap(([request]) => diagnosticRecords(request.data))

describe('lifecycle diagnostic transport', () => {
  beforeAll(() => {
    // jsdom omits this browser API, used by browser-core to count non-ASCII bytes.
    Object.defineProperty(globalThis, 'TextEncoder', { value: TextEncoder, configurable: true })
  })
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    jest.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it.each(['ready', 'failed', 'cached_fallback'] as const)('sends one canonical %s report', (outcome) => {
    const telemetry = createLifecycleTelemetry(configuration())
    expect(mockSend).not.toHaveBeenCalled()
    jest.advanceTimersByTime(100)
    if (outcome === 'ready') telemetry.configurationReceived()
    jest.advanceTimersByTime(10)
    telemetry.settle(outcome)
    telemetry.settle(outcome)
    telemetry.stop()
    expect(records()).toHaveLength(1)
    expect(records()[0]).toEqual({
      type: 'sdk_diagnostic',
      schema_version: 1,
      payload: {
        event_type: 'sdk_initialization',
        timestamp: Date.now(),
        sdk_name: 'dd-openfeature-browser',
        sdk_version: '1.0.0-test',
        application_id: 'app-1',
        environment: 'staging',
        ...(outcome === 'ready' ? {} : { error_code: outcome === 'failed' ? 'INIT_FAILED' : 'CONFIG_FETCH_FAILED' }),
        initialization: {
          outcome,
          started_at_ms: Date.now() - 110,
          duration_ms: 110,
          final: true,
          milestones:
            outcome === 'ready'
              ? {
                  configuration_received: { elapsed_ms: 100 },
                  provider_ready: { elapsed_ms: 110 },
                }
              : {},
        },
      },
    })
    expect(JSON.stringify(records())).not.toContain('secret-client-token')
    telemetry.providerError()
    telemetry.stop()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it.each(['ready', 'failed', 'cached_fallback'] as const)('waits for slow %s without a timed snapshot', (outcome) => {
    const telemetry = createLifecycleTelemetry(configuration())
    jest.advanceTimersByTime(100)
    telemetry.configurationReceived()
    jest.advanceTimersByTime(60_000)
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockSendOnExit).not.toHaveBeenCalled()
    telemetry.settle(outcome)
    telemetry.stop()
    const payloads = records().map((record) => record.payload)
    expect(payloads).toHaveLength(1)
    expect(payloads[0].initialization).toMatchObject({ outcome, final: true, duration_ms: 60_100 })
    expect(payloads[0].initialization).not.toHaveProperty('sequence')
  })

  it('queues a pending page-exit snapshot before the existing exit transport flushes', () => {
    const config = configuration()
    const telemetry = createLifecycleTelemetry(config)
    expect(createHttpRequest).toHaveBeenCalledWith([config.flagEvaluationEndpointBuilder], expect.any(Function))
    mockExit.notify({ reason: 'page_hide' })
    expect(mockSendOnExit).toHaveBeenCalledTimes(1)
    const snapshot = diagnosticRecords(mockSendOnExit.mock.calls[0][0].data)[0].payload
    expect(snapshot.initialization).toMatchObject({
      outcome: 'incomplete',
      reason: 'page_exit',
      final: false,
      duration_ms: 0,
    })
    mockExit.notify({ reason: 'page_hide' })
    expect(mockSendOnExit).toHaveBeenCalledTimes(1)
    telemetry.configurationReceived()
    telemetry.settle('ready')
    telemetry.stop()
    expect(records()[0].payload.initialization).toMatchObject({ outcome: 'ready', final: true })
    expect(records()[0].payload.initialization.started_at_ms).toBe(snapshot.initialization.started_at_ms)
  })

  it('reports provider close while pending once', () => {
    const telemetry = createLifecycleTelemetry(configuration())
    telemetry.stop()
    jest.advanceTimersByTime(60_000)
    mockExit.notify({ reason: 'page_hide' })
    expect(records()).toHaveLength(1)
    expect(records()[0].payload.initialization).toMatchObject({
      outcome: 'incomplete',
      reason: 'provider_closed',
      final: false,
    })
    expect(mockSendOnExit).not.toHaveBeenCalled()
  })

  it('reports only provider close after a long pending initialization', () => {
    const telemetry = createLifecycleTelemetry(configuration())
    jest.advanceTimersByTime(30_000)
    telemetry.stop()
    expect(records()).toHaveLength(1)
    expect(records()[0].payload.initialization.reason).toBe('provider_closed')
  })

  it('bounds provider errors to one after initialization settles', () => {
    const telemetry = createLifecycleTelemetry(configuration())
    telemetry.providerError()
    telemetry.settle('cached_fallback')
    telemetry.providerError()
    telemetry.providerError()
    telemetry.stop()
    expect(records().map((record) => record.payload.event_type)).toEqual(['sdk_initialization', 'provider_error'])
    expect(records()[1].payload.error_code).toBe('CONFIG_FETCH_FAILED')
    expect(records()[1].payload.initialization).toBeUndefined()
  })

  it('keeps monotonic durations when the wall clock moves forward', () => {
    const telemetry = createLifecycleTelemetry(configuration())
    jest.advanceTimersByTime(10)
    telemetry.configurationReceived()
    jest.setSystemTime(Date.now() + 60_000)
    jest.advanceTimersByTime(10)
    telemetry.settle('ready')
    telemetry.stop()
    expect(records()[0].payload.initialization.duration_ms).toBe(20)
  })

  it('does not send an invalid report after the wall clock moves before initialization', () => {
    const telemetry = createLifecycleTelemetry(configuration())
    jest.setSystemTime(Date.now() - 60_000)
    telemetry.settle('failed')
    telemetry.stop()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('keeps reports independent for each provider instance', () => {
    const first = createLifecycleTelemetry(configuration())
    const second = createLifecycleTelemetry(configuration())
    first.settle('failed')
    second.settle('failed')
    first.stop()
    second.stop()
    expect(records()).toHaveLength(2)
    for (const record of records()) expect(record.payload).not.toHaveProperty('runtime_id')
  })

  it.each([
    { applicationId: undefined, service: 'x'.repeat(201) },
    { env: undefined },
    { env: '\u0000bad' },
    { env: ' whitespace ' },
  ])('does not upload with invalid identity/environment: %j', (override) => {
    const telemetry = createLifecycleTelemetry({ ...configuration(), ...override })
    telemetry.settle('failed')
    telemetry.stop()
    expect(mockSend).not.toHaveBeenCalled()
    expect(console.log).not.toHaveBeenCalled()
  })

  it('sends exactly one identity, preferring applicationId over service', () => {
    for (const applicationId of ['app-1', undefined]) {
      mockSend.mockClear()
      const telemetry = createLifecycleTelemetry({ ...configuration(), applicationId, service: 'checkout' })
      telemetry.settle('failed')
      telemetry.stop()
      const payload = records()[0].payload
      expect(payload.application_id).toBe(applicationId)
      expect(payload.service_id).toBe(applicationId ? undefined : 'checkout')
    }
  })

  it('preserves multibyte metadata using the normal transport', () => {
    const telemetry = createLifecycleTelemetry({
      ...configuration(),
      service: '漢'.repeat(200),
      applicationId: undefined,
      env: '漢'.repeat(200),
    })
    telemetry.configurationReceived()
    telemetry.settle('ready')
    telemetry.stop()
    expect(records()).toHaveLength(1)
  })

  it('handles upload failures without console output', () => {
    const telemetry = createLifecycleTelemetry(configuration())
    telemetry.settle('failed')
    const onError = jest.mocked(createHttpRequest).mock.calls[0][1]
    expect(() => onError?.({} as never)).not.toThrow()
    telemetry.stop()
    expect(records()).toHaveLength(1)
    expect(console.log).not.toHaveBeenCalled()
  })
})
