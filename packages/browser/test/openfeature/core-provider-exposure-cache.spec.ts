import { getGlobalObject, INTAKE_SITE_STAGING } from '@datadog/browser-core'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import { configurationFromRulesBinary } from '@datadog/flagging-core/rules-based'
import { MultiProvider, OpenFeature, type Provider } from '@openfeature/web-sdk'
import { IDBFactory } from 'fake-indexeddb'
import type { FlaggingTrackingInitConfiguration } from '../../src/domain/configuration'
import { DatadogDevtools } from '../../src/openfeature/devtools-provider'
import { type ExposureEvaluation, ExposureHook } from '../../src/openfeature/exposure-hook'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import {
  composeDatadogTrackingHooks,
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  DatadogCoreProvider,
} from '../../src/rules-based'

const DOMAIN = 'datadog-core-exposure-cache'

const trackingConfig: FlaggingTrackingInitConfiguration = {
  clientToken: 'test-client-token',
  applicationId: 'test-app-id',
  env: 'test',
  site: INTAKE_SITE_STAGING,
}

// Hand-built protobuf FlagsConfiguration, matching the vendored ufc.proto field
// numbers, so the fixture can vary serial ids, variants and split features.
function varint(input: number): number[] {
  const bytes: number[] = []
  let value = input
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value) byte |= 0x80
    bytes.push(byte)
  } while (value)
  return bytes
}

function protobufField(field: number, wireType: number, value: number[]): number[] {
  return [...varint((field << 3) | wireType), ...value]
}

function protobufVarint(field: number, value: number): number[] {
  return protobufField(field, 0, varint(value))
}

function protobufMessage(field: number, value: number[]): number[] {
  return protobufField(field, 2, [...varint(value.length), ...value])
}

function protobufString(field: number, value: string): number[] {
  return protobufMessage(field, [...Array.from(value, (char) => char.charCodeAt(0))])
}

function protobufDouble(field: number, value: number): number[] {
  const buffer = new ArrayBuffer(8)
  new DataView(buffer).setFloat64(0, value, true)
  return protobufField(field, 1, [...new Uint8Array(buffer)])
}

interface FixtureFeature {
  key: string
  value: { type: 'string'; value: string } | { type: 'number'; value: number } | { type: 'boolean'; value: boolean }
  destinations: string[]
}

function protobufFeature(feature: FixtureFeature): number[] {
  return [
    ...protobufString(1, feature.key),
    ...(feature.value.type === 'string'
      ? protobufString(2, feature.value.value)
      : feature.value.type === 'number'
        ? protobufDouble(3, feature.value.value)
        : protobufVarint(4, feature.value.value ? 1 : 0)),
    ...feature.destinations.flatMap((destination) => protobufString(5, destination)),
  ]
}

function rulesConfiguration({
  variationIndex = 0,
  serialId = 1001,
  features = [],
}: { variationIndex?: number; serialId?: number; features?: FixtureFeature[] } = {}): FlagsConfiguration {
  const split = [
    ...protobufMessage(1, [...protobufVarint(1, 0), ...protobufVarint(2, 100)]),
    ...protobufVarint(2, variationIndex),
    ...protobufVarint(3, serialId),
    ...protobufVarint(4, 1),
    ...features.flatMap((feature) => protobufMessage(5, protobufFeature(feature))),
  ]
  const allocation = [
    ...protobufString(1, 'holdout-allocation'),
    ...protobufMessage(3, [
      ...protobufMessage(2, [...protobufString(1, 'serial-salt'), ...protobufVarint(2, 0), ...protobufVarint(3, 100)]),
    ]),
    ...protobufMessage(4, split),
    ...protobufVarint(5, 1),
  ]
  const flag = [
    ...protobufVarint(2, 4),
    ...protobufMessage(3, [...protobufVarint(1, 0), ...protobufVarint(5, 1)]),
    ...protobufMessage(3, [...protobufVarint(1, 1), ...protobufVarint(5, 0)]),
    ...protobufMessage(4, allocation),
  ]
  const configuration = [
    ...protobufString(2, 'test'),
    ...protobufMessage(3, [...protobufString(1, 'holdout-flag'), ...protobufMessage(2, flag)]),
    ...protobufMessage(4, protobufMessage(1, [])),
    ...protobufString(5, 'control'),
    ...protobufString(5, 'treatment'),
  ]
  return configurationFromRulesBinary(new Uint8Array(configuration))
}

const context = { targetingKey: 'rules-user' }

const exposureCalls = (fetchMock: jest.Mock) =>
  fetchMock.mock.calls.filter(([url]) => url.toString().includes('exposures'))
const exposureEvents = (fetchMock: jest.Mock) =>
  exposureCalls(fetchMock).flatMap(([, request]) =>
    (request.body as string)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  )

describe('DatadogCoreProvider with a shared exposure cache', () => {
  let fetchMock: jest.Mock
  let originalFetch: typeof global.fetch

  beforeAll(() => {
    originalFetch = global.fetch
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = fetchMock
    jest.useFakeTimers()
  })

  afterAll(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
  })

  beforeEach(async () => {
    await OpenFeature.clearProviders()
    await OpenFeature.clearContext()
    OpenFeature.clearHandlers()
    OpenFeature.clearHooks()
    OpenFeature.getClient(DOMAIN).clearHooks()
    delete getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM
    globalThis.indexedDB = new IDBFactory()
    // Pending exposure batches from the previous test flush on the next timer tick.
    jest.advanceTimersByTime(31000)
    await Promise.resolve()
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 })
  })

  it('exposes the cache on the controller and on a composition', () => {
    const exposure = createDatadogExposureLoggingHook(trackingConfig)
    expect(exposure.exposureCache).toBeDefined()

    const composed = composeDatadogTrackingHooks(
      createDatadogEvaluationLoggingHook(trackingConfig),
      exposure,
      createDatadogExposureLoggingHook(trackingConfig)
    )
    // Exactly one cache can be shared: the first exposure controller's.
    expect(composed.exposureCache).toBe(exposure.exposureCache)
  })

  it('stamps one verdict per evaluation and agrees with the Datadog send', async () => {
    const tracking = createDatadogExposureLoggingHook(trackingConfig)
    await tracking.initialize()
    const provider = new DatadogCoreProvider({ exposureCache: tracking.exposureCache })
    provider.setConfiguration(
      rulesConfiguration({
        features: [
          { key: 'holdout.key', value: { type: 'string', value: '06ad' }, destinations: ['HOOK'] },
          { key: 'exposure.only', value: { type: 'string', value: 'exposed' }, destinations: ['EXPOSURE'] },
        ],
      })
    )
    await OpenFeature.setProviderAndWait(DOMAIN, provider, context)
    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...tracking.hooks)

    const first = client.getBooleanDetails('holdout-flag', false)
    expect(first.value).toBe(true)
    expect(first.variant).toBe('control')
    expect(first.flagMetadata?.__dd_exposure_cache_hit).toBe(false)

    const second = client.getBooleanDetails('holdout-flag', false)
    expect(second.flagMetadata?.__dd_exposure_cache_hit).toBe(true)

    jest.advanceTimersByTime(31000)
    expect(exposureEvents(fetchMock)).toEqual([
      expect.objectContaining({
        flag: { key: 'holdout-flag' },
        allocation: { key: 'holdout-allocation' },
        variant: { key: 'control' },
        serial_id: 1001,
        features: { 'exposure.only': 'exposed' },
      }),
    ])
  })

  it.each([
    ['MultiProvider', (provider: Provider) => new MultiProvider([{ provider }])],
    ['MultiProvider inside DatadogDevtools', (provider: Provider) => new DatadogDevtools(new MultiProvider([{ provider }]))],
  ])('disables exposures under %s and keeps evaluating', async (_name, compose) => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const tracking = createDatadogExposureLoggingHook(trackingConfig)
    await tracking.initialize()
    const provider = new DatadogCoreProvider({ exposureCache: tracking.exposureCache })
    provider.setConfiguration(rulesConfiguration())
    await OpenFeature.setProviderAndWait(DOMAIN, compose(provider), context)
    const client = OpenFeature.getClient(DOMAIN)
    const evaluations: ExposureEvaluation[] = []
    client.addHooks(...tracking.hooks, new ExposureHook((evaluation) => evaluations.push(evaluation)))

    expect(client.getBooleanDetails('holdout-flag', false).value).toBe(true)
    expect(client.getBooleanDetails('holdout-flag', false).value).toBe(true)

    jest.advanceTimersByTime(31000)
    expect(exposureEvents(fetchMock)).toEqual([])
    expect(evaluations).toEqual([])

    // Nothing was recorded, so the first direct evaluation is a new exposure.
    await OpenFeature.setProviderAndWait(DOMAIN, provider, context)
    expect(client.getBooleanDetails('holdout-flag', false).flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    await tracking.shutdown()
  })

  it('keeps exposures under DatadogDevtools', async () => {
    const tracking = createDatadogExposureLoggingHook(trackingConfig)
    await tracking.initialize()
    const provider = new DatadogCoreProvider({ exposureCache: tracking.exposureCache })
    provider.setConfiguration(rulesConfiguration())
    await OpenFeature.setProviderAndWait(DOMAIN, new DatadogDevtools(provider), context)
    const client = OpenFeature.getClient(DOMAIN)
    const evaluations: ExposureEvaluation[] = []
    client.addHooks(...tracking.hooks, new ExposureHook((evaluation) => evaluations.push(evaluation)))

    expect(client.getBooleanDetails('holdout-flag', false).flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(client.getBooleanDetails('holdout-flag', false).flagMetadata?.__dd_exposure_cache_hit).toBe(true)
    expect(evaluations.map((evaluation) => evaluation.shouldSend())).toEqual([true, false])

    jest.advanceTimersByTime(31000)
    expect(exposureEvents(fetchMock)).toHaveLength(1)
    await tracking.shutdown()
  })

  it('treats a variant or serial id change as a new exposure', async () => {
    const tracking = createDatadogExposureLoggingHook(trackingConfig)
    await tracking.initialize()
    const provider = new DatadogCoreProvider({ exposureCache: tracking.exposureCache })
    provider.setConfiguration(rulesConfiguration())
    await OpenFeature.setProviderAndWait(DOMAIN, provider, context)
    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...tracking.hooks)

    expect(client.getBooleanDetails('holdout-flag', false).flagMetadata?.__dd_exposure_cache_hit).toBe(false)

    provider.setConfiguration(rulesConfiguration({ serialId: 1002 }))
    expect(client.getBooleanDetails('holdout-flag', false).flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(client.getBooleanDetails('holdout-flag', false).flagMetadata?.__dd_exposure_cache_hit).toBe(true)

    provider.setConfiguration(rulesConfiguration({ variationIndex: 1 }))
    const changedVariant = client.getBooleanDetails('holdout-flag', false)
    expect(changedVariant.variant).toBe('treatment')
    expect(changedVariant.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
  })

  it('does not stamp or record a failed evaluation', async () => {
    const tracking = createDatadogExposureLoggingHook(trackingConfig)
    await tracking.initialize()
    const provider = new DatadogCoreProvider({ exposureCache: tracking.exposureCache })
    provider.setConfiguration(rulesConfiguration())
    await OpenFeature.setProviderAndWait(DOMAIN, provider, context)
    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...tracking.hooks)

    const failed = client.getBooleanDetails('missing-flag', false)
    expect(failed.errorCode).toBe('FLAG_NOT_FOUND')
    expect(failed.flagMetadata?.__dd_exposure_cache_hit).toBeUndefined()

    expect(client.getBooleanDetails('holdout-flag', false).flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    jest.advanceTimersByTime(31000)
    expect(exposureEvents(fetchMock)).toHaveLength(1)
  })

  it('records without sending in record-only mode, with matching hook verdicts', async () => {
    const tracking = createDatadogExposureLoggingHook({ ...trackingConfig, trackExposures: false })
    await tracking.initialize()
    const provider = new DatadogCoreProvider({ exposureCache: tracking.exposureCache })
    provider.setConfiguration(rulesConfiguration())
    await OpenFeature.setProviderAndWait(DOMAIN, provider, context)
    const evaluations: ExposureEvaluation[] = []
    OpenFeature.addHooks(new ExposureHook((evaluation) => evaluations.push(evaluation)))
    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...tracking.hooks)

    client.getBooleanValue('holdout-flag', false)
    client.getBooleanValue('holdout-flag', false)
    jest.advanceTimersByTime(31000)

    expect(exposureCalls(fetchMock)).toHaveLength(0)
    expect(evaluations).toHaveLength(2)
    expect(evaluations[0].isExposure()).toBe(true)
    expect(evaluations[0].shouldSend()).toBe(true)
    expect(evaluations[1].isCacheHit()).toBe(true)
    expect(evaluations[1].shouldSend()).toBe(false)
  })

  it('keeps the deprecated alias working in record-only mode', async () => {
    const tracking = createDatadogExposureLoggingHook({ ...trackingConfig, enableExposureLogging: false })
    await tracking.initialize()
    const provider = new DatadogCoreProvider({ exposureCache: tracking.exposureCache })
    provider.setConfiguration(rulesConfiguration())
    await OpenFeature.setProviderAndWait(DOMAIN, provider, context)
    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...tracking.hooks)

    client.getBooleanValue('holdout-flag', false)
    jest.advanceTimersByTime(31000)

    expect(exposureCalls(fetchMock)).toHaveLength(0)
  })

  it('changes nothing without the shared cache option', async () => {
    const tracking = createDatadogExposureLoggingHook(trackingConfig)
    await tracking.initialize()
    const provider = new DatadogCoreProvider()
    provider.setConfiguration(rulesConfiguration())
    await OpenFeature.setProviderAndWait(DOMAIN, provider, context)
    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...tracking.hooks)

    const first = client.getBooleanDetails('holdout-flag', false)
    expect(first.flagMetadata?.__dd_exposure_cache_hit).toBeUndefined()
    expect(client.getBooleanDetails('holdout-flag', false).flagMetadata?.__dd_exposure_cache_hit).toBeUndefined()

    // The controller still deduplicates its own Datadog send.
    jest.advanceTimersByTime(31000)
    expect(exposureEvents(fetchMock)).toHaveLength(1)
  })

  it('deduplicates a reentrant successful evaluation', async () => {
    const tracking = createDatadogExposureLoggingHook(trackingConfig)
    await tracking.initialize()
    const provider = new DatadogCoreProvider({ exposureCache: tracking.exposureCache })
    provider.setConfiguration(rulesConfiguration())
    await OpenFeature.setProviderAndWait(DOMAIN, provider, context)
    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...tracking.hooks)
    const rows: ExposureEvaluation[] = []
    client.addHooks(new ExposureHook((e) => rows.push(e)))
    let nested = false
    client.addHooks({
      after: () => {
        if (!nested) {
          nested = true
          client.getBooleanDetails('holdout-flag', false)
        }
      },
    })

    expect(client.getBooleanDetails('holdout-flag', false).value).toBe(true)
    jest.advanceTimersByTime(31000)
    expect(exposureEvents(fetchMock)).toHaveLength(1)
    expect(rows.map((row) => row.shouldSend())).toEqual([true, false])
    await tracking.shutdown()
  })

  it.each(['tracking first', 'customer first'])(
    'deduplicates a nested evaluation from a customer callback (hooks registered: %s)',
    async (order) => {
      const tracking = createDatadogExposureLoggingHook(trackingConfig)
      await tracking.initialize()
      const provider = new DatadogCoreProvider({ exposureCache: tracking.exposureCache })
      provider.setConfiguration(rulesConfiguration())
      await OpenFeature.setProviderAndWait(DOMAIN, provider, context)
      const client = OpenFeature.getClient(DOMAIN)
      const nestedCallback = new ExposureHook((e) => {
        if (e.isExposure() && e.shouldSend()) client.getBooleanDetails('holdout-flag', false)
      })
      if (order === 'tracking first') {
        client.addHooks(...tracking.hooks)
        client.addHooks(nestedCallback)
      } else {
        client.addHooks(nestedCallback)
        client.addHooks(...tracking.hooks)
      }

      expect(client.getBooleanDetails('holdout-flag', false).value).toBe(true)
      jest.advanceTimersByTime(31000)
      expect(exposureEvents(fetchMock)).toHaveLength(1)
      await tracking.shutdown()
    }
  )

  it('does not let a rejected evaluation consume admission', async () => {
    const tracking = createDatadogExposureLoggingHook({ ...trackingConfig, trackExposures: false })
    await tracking.initialize()
    const provider = new DatadogCoreProvider({ exposureCache: tracking.exposureCache })
    provider.setConfiguration(rulesConfiguration())
    await OpenFeature.setProviderAndWait(DOMAIN, provider, context)
    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...tracking.hooks)
    const rows: ExposureEvaluation[] = []
    client.addHooks(new ExposureHook((e) => rows.push(e)))
    let afterHooks = 0
    client.addHooks({
      after: () => {
        afterHooks += 1
        if (afterHooks === 1) throw new Error('application hook failed')
      },
    })

    const rejected = client.getBooleanDetails('holdout-flag', false)
    expect(rejected.errorCode).toBe('GENERAL')
    expect(exposureCalls(fetchMock)).toHaveLength(0)

    const retried = client.getBooleanDetails('holdout-flag', false)
    expect(retried.errorCode).toBeUndefined()
    expect(retried.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    jest.advanceTimersByTime(31000)
    expect(exposureCalls(fetchMock)).toHaveLength(0)
    expect(rows.map((row) => row.shouldSend())).toEqual([false, true])
    await tracking.shutdown()
  })

  it('records through the provider finalizer without registered tracking hooks', async () => {
    // The cache is shared with the provider but no tracking hooks are
    // registered; the provider's own finalizer must still complete the decision.
    const tracking = createDatadogExposureLoggingHook(trackingConfig)
    await tracking.initialize()
    const provider = new DatadogCoreProvider({ exposureCache: tracking.exposureCache })
    provider.setConfiguration(rulesConfiguration())
    await OpenFeature.setProviderAndWait(DOMAIN, provider, context)
    const client = OpenFeature.getClient(DOMAIN)

    const first = client.getBooleanDetails('holdout-flag', false)
    expect(first.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    const second = client.getBooleanDetails('holdout-flag', false)
    expect(second.flagMetadata?.__dd_exposure_cache_hit).toBe(true)
    await tracking.shutdown()
  })

  it('waits for the shared cache to load before initialize completes', async () => {
    let resolveInit: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      resolveInit = resolve
    })
    const cache = {
      init: () => ready,
      has: () => false,
      set: jest.fn(),
      clear: jest.fn(),
    }
    const provider = new DatadogCoreProvider({ exposureCache: cache })
    provider.setConfiguration(rulesConfiguration())

    let initialized = false
    const initialize = provider.initialize(context).then(() => {
      initialized = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(initialized).toBe(false)

    resolveInit()
    await initialize
    expect(initialized).toBe(true)
  })
})
