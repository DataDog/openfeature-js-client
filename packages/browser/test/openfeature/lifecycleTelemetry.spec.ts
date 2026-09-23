import { createHttpRequest, Observable, type PageMayExitEvent } from '@datadog/browser-core'
import { validateAndBuildFlaggingConfiguration } from '../../src/domain/configuration'
import { createLifecycleTelemetry, logDiagnostic } from '../../src/openfeature/lifecycleTelemetry'

const mockSend = jest.fn()
const mockSendOnExit = jest.fn()
const mockExit = new Observable<PageMayExitEvent>()
jest.mock('@datadog/browser-core', () => ({
  ...jest.requireActual('@datadog/browser-core'),
  createHttpRequest: jest.fn(() => ({ send: mockSend, sendOnExit: mockSendOnExit })),
  createPageMayExitObservable: () => mockExit,
}))

const types = [
  'sdk_init_started',
  'configuration_received',
  'provider_ready',
  'provider_error',
  'init_timeout',
  'init_failed',
] as const

function configuration() {
  const config = validateAndBuildFlaggingConfiguration({
    clientToken: 'secret-client-token',
    applicationId: 'app-1',
    env: 'staging',
  })
  if (!config) throw new Error('Invalid test configuration')
  return config
}

describe('lifecycle diagnostic transport', () => {
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

  it('serializes six deduplicated envelopes with one runtime ID, without evaluations or credentials', () => {
    const telemetry = createLifecycleTelemetry(configuration())
    for (const type of types) {
      telemetry.emit(type)
      telemetry.emit(type)
    }
    telemetry.stop()
    expect(mockSend).toHaveBeenCalledTimes(1)
    const body: string = mockSend.mock.calls[0][0].data
    const records = body.split('\n').map((line: string) => JSON.parse(line))
    expect(records.map((record) => record.payload.event_type)).toEqual(types)
    expect(new Set(records.map((record) => record.payload.runtime_id)).size).toBe(1)
    expect(records.map((record) => record.payload.error_code)).toEqual([
      undefined,
      undefined,
      undefined,
      'CONFIG_FETCH_FAILED',
      'INIT_TIMEOUT',
      'INIT_FAILED',
    ])
    for (const record of records) {
      expect(record).toEqual({
        schema_version: 1,
        event_family: 'sdk_diagnostic',
        payload: {
          event_type: record.payload.event_type,
          timestamp: expect.any(Number),
          runtime_id: expect.any(String),
          sdk_name: 'dd-openfeature-browser',
          sdk_version: '1.0.0-test',
          application_id: 'app-1',
          environment: 'staging',
          ...(record.payload.error_code && { error_code: record.payload.error_code }),
        },
      })
      expect(new Blob([JSON.stringify(record)]).size).toBeLessThanOrEqual(2048)
    }
    expect(body).not.toContain('secret-client-token')
    telemetry.emit('sdk_init_started')
    telemetry.stop()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('uses the existing flag evaluation endpoint and page-exit send path', () => {
    const config = configuration()
    const telemetry = createLifecycleTelemetry(config)
    expect(createHttpRequest).toHaveBeenCalledWith([config.flagEvaluationEndpointBuilder], expect.any(Function))
    telemetry.emit('sdk_init_started')
    mockExit.notify({ reason: 'page_hide' })
    expect(mockSendOnExit).toHaveBeenCalledTimes(1)
    telemetry.stop()
  })

  it('keeps diagnostics local when identity or environment is invalid', () => {
    const config = configuration()
    config.applicationId = undefined
    config.service = 'x'.repeat(201)
    const telemetry = createLifecycleTelemetry(config, true)
    telemetry.emit('sdk_init_started')
    telemetry.stop()
    expect(mockSend).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('[Datadog Feature Flags]', 'sdk_init_started', '')
    mockSend.mockClear()
    const big = createLifecycleTelemetry({
      ...config,
      applicationId: '漢'.repeat(128),
      service: '\u0000'.repeat(200),
      env: '\u0000'.repeat(200),
    })
    big.emit('provider_ready')
    big.stop()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('sends exactly one identity, preferring applicationId over service', () => {
    for (const applicationId of ['app-1', undefined]) {
      mockSend.mockClear()
      const telemetry = createLifecycleTelemetry({ ...configuration(), applicationId, service: 'checkout' })
      telemetry.emit('provider_ready')
      telemetry.stop()
      const payload = JSON.parse(mockSend.mock.calls[0][0].data).payload
      expect(payload.application_id).toBe(applicationId)
      expect(payload.service_id).toBe(applicationId ? undefined : 'checkout')
      expect(payload.service).toBeUndefined()
    }
  })

  it('does not upload when env is absent', () => {
    const telemetry = createLifecycleTelemetry({ ...configuration(), env: undefined }, true)
    telemetry.emit('init_failed')
    telemetry.stop()
    expect(mockSend).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalled()
  })

  it('does not recurse or throw when telemetry upload or local logging fails', () => {
    const telemetry = createLifecycleTelemetry(configuration(), true)
    const onError = jest.mocked(createHttpRequest).mock.calls[0][1]
    expect(() => onError?.({} as never)).not.toThrow()
    expect(mockSend).not.toHaveBeenCalled()
    jest.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('console unavailable')
    })
    expect(() => logDiagnostic('details', { value: true })).not.toThrow()
    expect(() => telemetry.emit('sdk_init_started')).not.toThrow()
    telemetry.stop()
  })

  it.each([undefined, false, true])('gates only console output with debugMode=%s', (debugMode) => {
    const telemetry = createLifecycleTelemetry(configuration(), debugMode)
    for (const type of types) telemetry.emit(type)
    const onError = jest.mocked(createHttpRequest).mock.calls[0][1]
    onError?.({} as never)
    telemetry.stop()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend.mock.calls[0][0].data.split('\n')).toHaveLength(6)
    if (debugMode) {
      expect(console.log).toHaveBeenCalledTimes(7)
    } else {
      expect(console.log).not.toHaveBeenCalled()
    }
  })

  it('does not print missing-identity diagnostics without debug mode', () => {
    const telemetry = createLifecycleTelemetry({ ...configuration(), applicationId: undefined })
    telemetry.emit('sdk_init_started')
    telemetry.stop()
    expect(mockSend).not.toHaveBeenCalled()
    expect(console.log).not.toHaveBeenCalled()
  })
})
