import { OpenFeature } from '@openfeature/web-sdk'
import {
  configurationFromString,
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogTrackingHooks,
  DatadogCoreProvider,
  DatadogProvider,
  type DatadogTrackingHooks,
} from '../../src/rules-based'
import precomputedResponse from '../data/precomputed-v1.json'
import rulesWire from '../data/rules-v1-wire.json'

const options = { clientToken: 'tracking-token', env: 'test', flagEvaluationTrackingInterval: 1000 }
const domain = 'tracking-lifecycle'

describe('tracking resource lifecycle', () => {
  const controllers: DatadogTrackingHooks[] = []
  let originalFetch: typeof globalThis.fetch
  let fetchMock: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    localStorage.clear()
    originalFetch = globalThis.fetch
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock
  })

  afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.shutdown()))
    await OpenFeature.clearProviders()
    Reflect.deleteProperty(globalThis, 'chrome')
    globalThis.fetch = originalFetch
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it.each(['exposure', 'evaluation'] as const)('owns the %s hook resources until explicit shutdown', async (kind) => {
    const addListener = jest.spyOn(EventTarget.prototype, 'addEventListener')
    const removeListener = jest.spyOn(EventTarget.prototype, 'removeEventListener')
    const controller =
      kind === 'exposure' ? createDatadogExposureLoggingHook(options) : createDatadogEvaluationLoggingHook(options)
    controllers.push(controller)
    const client = await createClient()
    client.addHooks(...controller.hooks)

    client.getBooleanValue('test-flag', false)
    expect(jest.getTimerCount()).toBe(0)
    expect(addListener).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    await Promise.all([controller.initialize(), controller.initialize()])
    expect(addListener).toHaveBeenCalledTimes(3)
    client.getBooleanValue('test-flag', false)
    expect(jest.getTimerCount()).toBeGreaterThan(0)

    client.clearHooks()
    await OpenFeature.clearProviders()
    await controller.shutdown()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledTimes(3)

    await controller.shutdown()
    window.dispatchEvent(new Event('beforeunload'))
    jest.advanceTimersByTime(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledTimes(3)

    await controller.initialize()
    expect(addListener).toHaveBeenCalledTimes(6)
    await controller.shutdown()
    expect(removeListener).toHaveBeenCalledTimes(6)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('disables registered evaluation hooks after shutdown and can initialize them again', async () => {
    const controller = createDatadogEvaluationLoggingHook(options)
    controllers.push(controller)
    const client = await createClient()
    client.addHooks(...controller.hooks)
    await controller.initialize()
    client.getBooleanValue('test-flag', false)
    await controller.shutdown()
    fetchMock.mockClear()

    client.getBooleanValue('test-flag', false)
    jest.advanceTimersByTime(60_000)
    expect(fetchMock).not.toHaveBeenCalled()

    await controller.initialize()
    client.getBooleanValue('test-flag', false)
    jest.advanceTimersByTime(31_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('waits for pending exposure initialization before completing shutdown', async () => {
    let resolveRead!: (entries: Record<string, string>) => void
    let notifyRead!: () => void
    const readStarted = new Promise<void>((resolve) => {
      notifyRead = resolve
    })
    const storage = {
      get: jest.fn(
        () =>
          new Promise<Record<string, string>>((resolve) => {
            resolveRead = resolve
            notifyRead()
          })
      ),
    }
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: storage } } })
    const controller = createDatadogExposureLoggingHook(options)
    controllers.push(controller)
    const initialize = controller.initialize()
    await readStarted
    const shutdown = controller.shutdown()
    resolveRead({})
    await Promise.all([initialize, shutdown])

    const client = await createClient()
    client.addHooks(...controller.hooks)
    client.getBooleanValue('test-flag', false)
    jest.advanceTimersByTime(60_000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('shuts down all composed hooks even if another hook fails', async () => {
    const shutdown = jest.fn()
    const controller = createDatadogTrackingHooks(
      {
        hooks: [],
        shutdown: () => {
          throw new Error('synchronous failure')
        },
      },
      { hooks: [], shutdown: () => Promise.reject(new Error('asynchronous failure')) },
      { hooks: [], shutdown }
    )
    await expect(controller.shutdown()).resolves.toBeUndefined()
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('shuts down provider-owned tracking when OpenFeature clears the online provider', async () => {
    const provider = new DatadogProvider({
      ...options,
      enableRumFeatureFlagTracking: false,
      flagConfigurationFetch: jest.fn().mockResolvedValue({ ok: true, json: async () => precomputedResponse }),
    })
    expect(jest.getTimerCount()).toBe(0)
    await OpenFeature.setProviderAndWait(domain, provider, { targetingKey: 'online-user' })
    const client = OpenFeature.getClient(domain)
    expect(client.getStringValue('string-flag', 'default')).toBe('red')
    expect(jest.getTimerCount()).toBeGreaterThan(0)

    await OpenFeature.clearProviders()
    expect(jest.getTimerCount()).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    jest.advanceTimersByTime(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  async function createClient() {
    const provider = new DatadogCoreProvider()
    provider.setConfiguration(configurationFromString(JSON.stringify(rulesWire)))
    await OpenFeature.setProviderAndWait(domain, provider, { targetingKey: 'rules-user', country: 'US' })
    return OpenFeature.getClient(domain)
  }
})
