import { webcrypto } from 'node:crypto'
import { TextDecoder, TextEncoder } from 'node:util'
import { display } from '@datadog/browser-core'
import { ErrorCode, ProviderEvents } from '@openfeature/web-sdk'
import { setBuildFloorForTests } from '../../../src/transport/responseSigning/exchange'
import { forgetHighWaterMarks } from '../../../src/transport/responseSigning/minimumNotBefore'
import { BUILD_FLOOR } from '../../../src/transport/responseSigning/protocol'
import { ROOT_A } from './chainFixtures'

// The fixture times are before the build floor, so these tests turn it off. Each test starts with no high-water mark.
beforeAll(() => setBuildFloorForTests(0))
afterAll(() => setBuildFloorForTests(BUILD_FLOOR))
beforeEach(() => forgetHighWaterMarks())

// The verifier and its ASN.1 libraries load as a dynamic chunk only when signing is on and the site is staging.
type Controller = typeof import('../../../src/transport/responseSigning/controller')
type Protocol = typeof import('../../../src/transport/responseSigning/protocol')
type Provider = typeof import('../../../src/openfeature/provider')

const STAGING = { site: 'datad0g.com', clientToken: 'pub0123456789abcdef0123456789abcdef' }
const HEADERS = { 'content-type': 'application/json', 'dd-client-token': STAGING.clientToken }
const URL = 'https://preview.ff-cdn.datad0g.com/precompute-assignments'

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  Object.assign(globalThis, { TextEncoder, TextDecoder })
})
const EXCHANGE = '../../../src/transport/responseSigning/exchange'
afterEach(() => {
  jest.restoreAllMocks()
  jest.dontMock(EXCHANGE)
  jest.resetModules()
})

/** Loads the controller in a fresh module registry and counts the loads of the exchange chunk. */
function isolatedController(options: { failChunk?: boolean; stallChunk?: boolean } = {}): {
  controller: Controller
  protocol: Protocol
  provider: Provider
  loads: () => number
} {
  let loads = 0
  jest.resetModules()
  // The dynamic import runs later, so the mock stays in the registry until afterEach.
  jest.doMock(EXCHANGE, () => {
    loads += 1
    if (options.failChunk) throw new Error('ChunkLoadError: Loading chunk failed')
    // A module that is a thenable which never settles: the dynamic import never resolves, like a stalled chunk request.
    // biome-ignore lint/suspicious/noThenProperty: the test needs a thenable module to stall the dynamic import.
    if (options.stallChunk) return { __esModule: true, then: () => undefined }
    return jest.requireActual(EXCHANGE)
  })
  const controller: Controller = require('../../../src/transport/responseSigning/controller')
  const protocol: Protocol = require('../../../src/transport/responseSigning/protocol')
  const provider: Provider = require('../../../src/openfeature/provider')
  return { controller, protocol, provider, loads: () => loads }
}

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test.each([
  ['off', 'datad0g.com'],
  ['observe', 'datadoghq.com'],
  ['required', 'datadoghq.com'],
] as const)('mode %s on %s does not load the verifier chunk', async (mode, site) => {
  jest.spyOn(display, 'warn').mockImplementation(() => undefined)
  jest.spyOn(display, 'error').mockImplementation(() => undefined)
  const { controller, loads } = isolatedController()
  const signing = controller.createResponseSigningController({ mode }, { ...STAGING, site })
  if (signing) await expect(signing.prepare(URL, HEADERS, '{}')).rejects.toThrow('unsupported-site')
  await settle()
  expect(loads()).toBe(0)
})

test.each([
  ['an empty trustedRootCertificates', { trustedRootCertificates: [] }, {}],
  ['a cross-origin flaggingProxy', {}, { flaggingProxy: 'https://flags-proxy.example' }],
] as const)(
  'observe mode with %s sends ordinary requests and does not load the verifier chunk',
  async (_, signing, scope) => {
    const { controller, loads } = isolatedController()
    const core: typeof import('@datadog/browser-core') = require('@datadog/browser-core')
    const warn = jest.spyOn(core.display, 'warn').mockImplementation(() => undefined)
    expect(controller.createResponseSigningController({ mode: 'observe', ...signing }, { ...STAGING, ...scope })).toBe(
      undefined
    )
    await settle()
    expect(loads()).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(
      /^Flag response signing failed \(missing-anchor\): .* Flags are not verified\.$/
    )
  }
)

test.each(['observe', 'required'] as const)('mode %s on staging loads the verifier chunk once', async (mode) => {
  const { controller, loads } = isolatedController()
  const signing = controller.createResponseSigningController({ mode, trustedRootCertificates: [ROOT_A] }, STAGING)!
  await expect(signing.prepare(URL, HEADERS, '{}')).resolves.toBeDefined()
  await expect(signing.prepare(URL, HEADERS, '{}')).resolves.toBeDefined()
  expect(loads()).toBe(1)
})

test('required mode fails closed with verifier-unavailable when the verifier chunk does not load', async () => {
  const { controller, protocol } = isolatedController({ failChunk: true })
  const signing = controller.createResponseSigningController(
    { mode: 'required', trustedRootCertificates: [ROOT_A] },
    STAGING
  )!
  const error = await signing.prepare(URL, HEADERS, '{}').catch((thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(protocol.ResponseVerificationError)
  expect(error).toMatchObject({ reason: 'verifier-unavailable', message: controller.VERIFIER_UNAVAILABLE_MESSAGE })
  expect(controller.VERIFIER_UNAVAILABLE_MESSAGE).toBe(
    'Flag response signing failed (verifier-unavailable): The response signing verifier did not load. Check that the page can load the SDK chunk files.'
  )
})

test('a required provider emits one ERROR event and reports verifier-unavailable in evaluations', async () => {
  jest.spyOn(display, 'error').mockImplementation(() => undefined)
  const { controller, provider } = isolatedController({ failChunk: true })
  // The OpenFeature SDK from the same module registry as the provider.
  const { OpenFeature }: typeof import('@openfeature/web-sdk') = require('@openfeature/web-sdk')
  const previousFetch = global.fetch
  const fetch = jest.fn()
  global.fetch = fetch
  const domain = 'verifier-unavailable'
  const errors = jest.fn()
  const providerErrors = jest.fn()
  OpenFeature.getClient(domain).addHandler(ProviderEvents.Error, errors)
  try {
    const subject = new provider.DatadogProvider({
      ...STAGING,
      env: 'production',
      applicationId: 'app-a',
      enableFlagEvaluationTracking: false,
      enableRumFeatureFlagTracking: false,
      experimentalResponseSigning: { mode: 'required', trustedRootCertificates: [ROOT_A] },
    })
    subject.events.addHandler(ProviderEvents.Error, providerErrors)
    await expect(OpenFeature.setProviderAndWait(domain, subject, { targetingKey: 'user-123' })).rejects.toThrow(
      controller.VERIFIER_UNAVAILABLE_MESSAGE
    )
    await settle()
    // No assignment request leaves the client. Telemetry uses the /api/v2/ intake routes.
    expect(
      fetch.mock.calls.filter(([url]) => !new globalThis.URL(String(url)).pathname.startsWith('/api/v2/'))
    ).toEqual([])
    // The OpenFeature SDK emits the only ERROR event. @openfeature/core copies only the message, not errorCode.
    expect(providerErrors).not.toHaveBeenCalled()
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][0]).toMatchObject({ message: controller.VERIFIER_UNAVAILABLE_MESSAGE })
    expect(errors.mock.calls[0][0].errorCode).toBeUndefined()
    expect(subject.resolveBooleanEvaluation('critical', false, { targetingKey: 'user-123' }, logger)).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: ErrorCode.GENERAL,
      errorMessage: controller.VERIFIER_UNAVAILABLE_MESSAGE,
    })
  } finally {
    OpenFeature.getClient(domain).removeHandler(ProviderEvents.Error, errors)
    await OpenFeature.clearProviders()
    global.fetch = previousFetch
  }
})

test('observe mode sends the request without signing when the verifier chunk does not load', async () => {
  const { controller } = isolatedController({ failChunk: true })
  // The display module from the same module registry as the controller.
  const core: typeof import('@datadog/browser-core') = require('@datadog/browser-core')
  const warn = jest.spyOn(core.display, 'warn').mockImplementation(() => undefined)
  const signing = controller.createResponseSigningController(
    { mode: 'observe', trustedRootCertificates: [ROOT_A] },
    STAGING
  )!
  await expect(signing.prepare(URL, HEADERS, '{}')).resolves.toBeUndefined()
  await expect(signing.prepare(URL, HEADERS, '{}')).resolves.toBeUndefined()
  const response = new Response('{"data":{}}', { status: 200 })
  await expect(signing.read(response, undefined)).resolves.toEqual({ json: { data: {} } })
  // One warning for each reason code, without debug mode.
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith(`${controller.VERIFIER_UNAVAILABLE_MESSAGE} Flags are not verified.`)
})

describe('a stalled verifier chunk', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test.each(['observe', 'required'] as const)(
    'holds a %s request for at most VERIFIER_LOAD_TIMEOUT_MS',
    async (mode) => {
      const { controller } = isolatedController({ stallChunk: true })
      const core: typeof import('@datadog/browser-core') = require('@datadog/browser-core')
      jest.spyOn(core.display, 'warn').mockImplementation(() => undefined)
      const signing = controller.createResponseSigningController({ mode, trustedRootCertificates: [ROOT_A] }, STAGING)!
      let settled = false
      const result = signing.prepare(URL, HEADERS, '{}').then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      )
      result.finally(() => {
        settled = true
      })
      await jest.advanceTimersByTimeAsync(controller.VERIFIER_LOAD_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await jest.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      // Observe sends the request without signing; required fails closed.
      if (mode === 'observe') await expect(result).resolves.toEqual({ value: undefined })
      else await expect(result).resolves.toMatchObject({ error: { reason: 'verifier-unavailable' } })
      expect(jest.getTimerCount()).toBe(0)
    }
  )
  test.each(['observe', 'required'] as const)(
    'stops a cancelled %s request at once, without the load timeout or a verifier failure',
    async (mode) => {
      const { controller } = isolatedController({ stallChunk: true })
      const core: typeof import('@datadog/browser-core') = require('@datadog/browser-core')
      const warn = jest.spyOn(core.display, 'warn').mockImplementation(() => undefined)
      const signing = controller.createResponseSigningController({ mode, trustedRootCertificates: [ROOT_A] }, STAGING)!
      const abort = new AbortController()
      const result = signing.prepare(URL, HEADERS, '{}', undefined, abort.signal).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      )
      await jest.advanceTimersByTimeAsync(100)
      abort.abort(new DOMException('cancelled', 'AbortError'))
      await expect(result).resolves.toMatchObject({ error: { name: 'AbortError' } })
      expect(warn).not.toHaveBeenCalled()
      expect(jest.getTimerCount()).toBe(0)
    }
  )
})

test('a failed verifier chunk load is tried again on the next request', async () => {
  const { controller, loads } = isolatedController({ failChunk: true })
  const signing = controller.createResponseSigningController(
    { mode: 'required', trustedRootCertificates: [ROOT_A] },
    STAGING
  )!
  await expect(signing.prepare(URL, HEADERS, '{}')).rejects.toThrow(controller.VERIFIER_UNAVAILABLE_MESSAGE)
  await expect(signing.prepare(URL, HEADERS, '{}')).rejects.toThrow(controller.VERIFIER_UNAVAILABLE_MESSAGE)
  expect(loads()).toBeGreaterThan(1)
})
