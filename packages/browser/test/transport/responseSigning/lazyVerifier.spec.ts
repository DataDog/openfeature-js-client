import { webcrypto } from 'node:crypto'
import { TextDecoder, TextEncoder } from 'node:util'
import { display } from '@datadog/browser-core'
import { ROOT_A } from './chainFixtures'

// The verifier and its ASN.1 libraries load as a dynamic chunk only when signing is on and the site is staging.
type Controller = typeof import('../../../src/transport/responseSigning/controller')

const STAGING = { site: 'datad0g.com', clientToken: 'pub0123456789abcdef0123456789abcdef' }
const HEADERS = { 'dd-client-token': STAGING.clientToken }
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
function isolatedController(options: { failChunk?: boolean } = {}): { controller: Controller; loads: () => number } {
  let loads = 0
  jest.resetModules()
  // The dynamic import runs later, so the mock stays in the registry until afterEach.
  jest.doMock(EXCHANGE, () => {
    loads += 1
    if (options.failChunk) throw new Error('ChunkLoadError: Loading chunk failed')
    return jest.requireActual(EXCHANGE)
  })
  const controller: Controller = require('../../../src/transport/responseSigning/controller')
  return { controller, loads: () => loads }
}

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

test.each(['observe', 'required'] as const)('mode %s on staging loads the verifier chunk once', async (mode) => {
  const { controller, loads } = isolatedController()
  const signing = controller.createResponseSigningController({ mode, trustedRootCertificates: [ROOT_A] }, STAGING)!
  await expect(signing.prepare(URL, HEADERS, '{}')).resolves.toBeDefined()
  await expect(signing.prepare(URL, HEADERS, '{}')).resolves.toBeDefined()
  expect(loads()).toBe(1)
})

test('required mode fails closed and sends no request when the verifier chunk does not load', async () => {
  const { controller } = isolatedController({ failChunk: true })
  const signing = controller.createResponseSigningController(
    { mode: 'required', trustedRootCertificates: [ROOT_A] },
    STAGING
  )!
  await expect(signing.prepare(URL, HEADERS, '{}')).rejects.toThrow(controller.VERIFIER_UNAVAILABLE_MESSAGE)
})

test('observe mode sends the request without signing when the verifier chunk does not load', async () => {
  const { controller } = isolatedController({ failChunk: true })
  const signing = controller.createResponseSigningController(
    { mode: 'observe', trustedRootCertificates: [ROOT_A] },
    STAGING
  )!
  await expect(signing.prepare(URL, HEADERS, '{}')).resolves.toBeUndefined()
  const response = new Response('{"data":{}}', { status: 200 })
  await expect(signing.read(response, undefined)).resolves.toEqual({ json: { data: {} } })
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
