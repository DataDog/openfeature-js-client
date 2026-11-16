import { inspect, TextEncoder } from 'node:util'
import { addTelemetryDebug, display } from '@datadog/browser-core'
import { OpenFeature, ProviderEvents } from '@openfeature/web-sdk'
import { withStore } from '../../src/cache/indexeddb-store'
import { DatadogProvider } from '../../src/openfeature/provider'
import { fetchPrecomputedConfiguration } from '../../src/transport/fetchConfiguration'
import response from '../data/precomputed-v1.json'

const mockSend = jest.fn()
const mockSendOnExit = jest.fn()
jest.mock('@datadog/browser-core', () => ({
  ...jest.requireActual('@datadog/browser-core'),
  addTelemetryDebug: jest.fn(),
  createHttpRequest: jest.fn(() => ({ send: mockSend, sendOnExit: mockSendOnExit })),
}))

const jwt = 'private.jwt.signature'
const context = { targetingKey: 'user-a', dd_assignment_token: jwt }
const options = {
  clientToken: 'client-token',
  applicationId: 'test-app',
  env: 'test',
  enableRumFeatureFlagTracking: false,
}
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const success = () => new Response(JSON.stringify(response), { status: 200 })
const leakingError = () =>
  Object.assign(new Error(`Request failed: ${jwt}`), {
    cause: new Error(jwt),
    headers: { 'DD-Assignment-Token': jwt },
    context,
  })

function expectNoCredential(value: unknown) {
  // Include non-enumerable message, stack and cause fields, not just JSON.stringify(Error).
  const serialized = inspect(value, { depth: 20, showHidden: true })
  expect(serialized).not.toContain(jwt)
  expect(serialized).not.toContain('dd_assignment_token')
  expect(serialized).not.toContain('DD-Assignment-Token')
}

function loggedData() {
  return [
    ...Object.values(logger).map((method) => method.mock.calls),
    (display.error as jest.Mock).mock.calls,
    (display.warn as jest.Mock).mock.calls,
    (addTelemetryDebug as jest.Mock).mock.calls,
    mockSend.mock.calls,
    mockSendOnExit.mock.calls,
  ]
}

describe('assignment credential diagnostic isolation', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'TextEncoder', { value: TextEncoder, configurable: true })
  })
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(display, 'error').mockImplementation(() => {})
    jest.spyOn(display, 'warn').mockImplementation(() => {})
    OpenFeature.setLogger(logger)
  })
  afterEach(async () => {
    await OpenFeature.clearProviders()
    await withStore('readwrite', (store) => store.count())
    OpenFeature.setLogger(console)
    jest.restoreAllMocks()
  })

  it.each([
    [
      'synchronous transport throw',
      () => {
        throw leakingError()
      },
      'Error',
    ],
    [
      'rejected transport',
      async () => {
        throw leakingError()
      },
      'Error',
    ],
    [
      'thrown string',
      async () => {
        throw jwt
      },
      'Error',
    ],
    [
      'thrown object',
      async () => {
        throw { message: jwt, context }
      },
      'Error',
    ],
    [
      'transport cancellation',
      async () => {
        throw new DOMException(jwt, 'AbortError')
      },
      'AbortError',
    ],
    [
      'transport timeout',
      async () => {
        throw new DOMException(jwt, 'TimeoutError')
      },
      'TimeoutError',
    ],
    ['malformed JSON response', async () => new Response(jwt, { status: 200 }), 'ParseError'],
    [
      'response-body rejection',
      async () => {
        const result = success()
        jest.spyOn(result, 'json').mockRejectedValue(leakingError())
        return result
      },
      'ParseError',
    ],
    [
      'response-body cancellation',
      async () => {
        const result = success()
        jest.spyOn(result, 'json').mockRejectedValue(new DOMException(jwt, 'AbortError'))
        return result
      },
      'AbortError',
    ],
  ] as const)('sanitizes %s before provider events, logs and diagnostics', async (_name, fetch, expectedName) => {
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetch })
    const errors = jest.fn()
    provider.events.addHandler(ProviderEvents.Error, errors)
    const caught = await OpenFeature.setProviderAndWait(provider, context).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toHaveProperty('name', expectedName)
    expect(errors).toHaveBeenCalled()
    OpenFeature.getClient().getBooleanValue('boolean-flag', false)
    await OpenFeature.clearProviders()
    const diagnostics = mockSend.mock.calls.flatMap(([request]) =>
      (request.data as string)
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    )
    expect(diagnostics.some((record) => record.type === 'sdk_diagnostic')).toBe(true)
    expect(diagnostics.some((record) => record.flag?.key === 'boolean-flag')).toBe(true)
    expectNoCredential([caught, errors.mock.calls, loggedData()])
  })

  it('redacts an echoed server diagnostic header from both console and debug telemetry', async () => {
    const provider = new DatadogProvider({
      ...options,
      flagSelection: { tags: ['beta'] },
      flagConfigurationFetch: async () =>
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'DD-Flag-Selection-Ignored': `DD-Assignment-Token=${jwt}` },
        }),
    })
    await OpenFeature.setProviderAndWait(provider, context)
    expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(true)
    expect(display.error).toHaveBeenCalledTimes(1)
    expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection ignored', { reason: 'redacted' })
    await OpenFeature.clearProviders()
    expectNoCredential(loggedData())
  })

  it('omits an unusable token without leaking it through diagnostics or emitted evaluation telemetry', async () => {
    const fetch = jest.fn().mockImplementation(success)
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetch })
    const errors = jest.fn()
    provider.events.addHandler(ProviderEvents.Error, errors)
    await OpenFeature.setProviderAndWait(provider, { ...context, dd_assignment_token: `${jwt}\r\n` })
    expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(new Headers(fetch.mock.calls[0][1].headers).has('DD-Assignment-Token')).toBe(false)
    expectNoCredential(fetch.mock.calls.map(([url, init]) => ({ url, headers: init.headers, body: init.body })))
    expect(errors).not.toHaveBeenCalled()
    expect(display.warn).toHaveBeenCalledTimes(1)
    expect(display.warn).toHaveBeenCalledWith(expect.stringContaining('Assignment token omitted'))
    await OpenFeature.clearProviders()
    const diagnostics = mockSend.mock.calls.flatMap(([request]) =>
      (request.data as string)
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    )
    expect(diagnostics.some((record) => record.type === 'sdk_diagnostic')).toBe(true)
    expect(diagnostics.some((record) => record.flag?.key === 'boolean-flag')).toBe(true)
    expectNoCredential([errors.mock.calls, loggedData()])
  })

  it.each([
    [
      'transport failure',
      async () => {
        throw leakingError()
      },
    ],
    ['invalid JSON', async () => new Response(jwt, { status: 200 })],
    ['HTTP failure', async () => new Response(jwt, { status: 503 })],
  ] as const)('keeps credentials out of enabled debug logs on %s', async (_name, fetch) => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const caught = await fetchPrecomputedConfiguration({
      ...options,
      context,
      debugMode: true,
      fetch,
    }).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(Error)
    expect(log).toHaveBeenCalled()
    expectNoCredential([caught, log.mock.calls])
  })

  it('keeps reserved context credentials out of enabled provider and tracking logs', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const provider = new DatadogProvider({
      ...options,
      debugMode: true,
      trackExposures: false,
      enableFlagEvaluationTracking: false,
      flagConfigurationFetch: async () => success(),
    })
    await OpenFeature.setProviderAndWait(provider, context)
    expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(true)
    await OpenFeature.clearProviders()
    expectNoCredential(log.mock.calls)
  })

  it('also sanitizes standalone assignment fetching', async () => {
    const caught = await fetchPrecomputedConfiguration({
      ...options,
      context,
      fetch: async () => {
        throw leakingError()
      },
    }).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(Error)
    expectNoCredential(caught)
  })

  it('preserves abort classification without forwarding a custom abort reason', async () => {
    const controller = new AbortController()
    const caught = await fetchPrecomputedConfiguration({
      ...options,
      context,
      signal: controller.signal,
      fetch: async () => {
        controller.abort(new DOMException(jwt, 'AbortError'))
        throw controller.signal.reason
      },
    }).catch((error: unknown) => error)
    expect(caught).toHaveProperty('name', 'AbortError')
    expectNoCredential(caught)
  })

  it('preserves existing transport error objects when there is no assignment token', async () => {
    const original = new TypeError('network failure')
    await expect(
      fetchPrecomputedConfiguration({
        ...options,
        context: { targetingKey: 'user-a' },
        fetch: async () => {
          throw original
        },
      })
    ).rejects.toBe(original)
  })

  it('preserves existing response-body errors when there is no assignment token', async () => {
    const original = new SyntaxError('invalid response')
    const result = success()
    jest.spyOn(result, 'json').mockRejectedValue(original)
    await expect(
      fetchPrecomputedConfiguration({
        ...options,
        context: { targetingKey: 'user-a' },
        fetch: async () => result,
      })
    ).rejects.toBe(original)
  })
})
