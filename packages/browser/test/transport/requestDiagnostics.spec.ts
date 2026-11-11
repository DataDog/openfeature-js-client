import { getGlobalObject } from '@datadog/browser-core'
import { DatadogProvider } from '../../src/openfeature/provider'
import { withRetry, withTimeout } from '../../src/transport/fetch'
import { fetchPrecomputedConfiguration } from '../../src/transport/fetchConfiguration'
import { generateUUIDv7 } from '../../src/transport/generateUUIDv7'
import {
  createRequestDiagnostics,
  type FetchTrigger,
  serializeRequestBody,
} from '../../src/transport/requestDiagnostics'
import precomputedResponse from '../data/precomputed-v1.json'

jest.mock('../../src/transport/generateUUIDv7', () => ({
  generateUUIDv7: jest.fn(jest.requireActual('../../src/transport/generateUUIDv7').generateUUIDv7),
}))

const options = {
  clientToken: 'secret-token',
  env: 'test',
  enableExposureLogging: false,
  enableFlagEvaluationTracking: false,
  enableRumFeatureFlagTracking: false,
}
const context = { targetingKey: 'private-user', secret: 'private-attribute' }
const payload = { data: { attributes: { subject: 'unchanged' } } }
const body = JSON.stringify(payload)
const rumGlobal = getGlobalObject<{ DD_RUM?: { getInternalContext?: () => unknown } }>()

function accept(tracker = createRequestDiagnostics(), trigger: FetchTrigger = 'initialization') {
  const signal = new AbortController().signal
  tracker.accept(signal, trigger)
  return { signal, diagnostics: JSON.parse(serializeRequestBody(payload, signal)).diagnostics }
}

describe('minimal request diagnostics', () => {
  afterEach(() => {
    delete rumGlobal.DD_RUM
    jest.restoreAllMocks()
  })

  it('adds exactly three fields with a timestamp-bearing UUIDv7 and stable instance identity', () => {
    const timestamp = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(timestamp)
    const tracker = createRequestDiagnostics()
    const first = accept(tracker).diagnostics
    const next = accept(tracker, 'context_change').diagnostics
    expect(Object.keys(first).sort()).toEqual(['fetch', 'sdk'])
    expect(Object.keys(first.sdk)).toEqual(['instance_id'])
    expect(Object.keys(first.fetch).sort()).toEqual(['sequence', 'trigger'])
    expect(first.sdk.instance_id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    expect(Number.parseInt(first.sdk.instance_id.replaceAll('-', '').slice(0, 12), 16)).toBe(timestamp)
    expect(next.sdk).toEqual(first.sdk)
    expect(next.fetch).toMatchObject({ sequence: 2, trigger: 'context_change' })
    expect(accept().diagnostics.sdk).not.toEqual(first.sdk)
  })

  it('keeps fetching available when UUID generation fails', () => {
    jest.mocked(generateUUIDv7).mockImplementationOnce(() => {
      throw new Error('secure randomness unavailable')
    })
    const tracker = createRequestDiagnostics()
    const signal = new AbortController().signal
    tracker.accept(signal, 'initialization')
    expect(serializeRequestBody(payload, signal)).toBe(body)
  })

  it('records the actual entry-point trigger independently of the sequence', () => {
    expect(accept(createRequestDiagnostics(), 'context_change').diagnostics.fetch).toMatchObject({
      sequence: 1,
      trigger: 'context_change',
    })
  })

  it('preserves the original body when diagnostics are unavailable or oversized', () => {
    expect(serializeRequestBody(payload)).toBe(body)
    expect(serializeRequestBody(payload, new AbortController().signal)).toBe(body)
    jest.spyOn(Blob.prototype, 'size', 'get').mockReturnValue(5000)
    const signal = new AbortController().signal
    createRequestDiagnostics().accept(signal, 'initialization')
    expect(serializeRequestBody(payload, signal)).toBe(body)
  })

  it('preserves assignment inputs and diagnostics across retries through timeout wrappers', async () => {
    const transport = jest
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(precomputedResponse)))
    const provider = new DatadogProvider({
      ...options,
      flagConfigurationFetch: withRetry(withTimeout(transport, 1000), 1),
    })
    await provider.initialize(context)
    const first = transport.mock.calls[0][1]
    const second = transport.mock.calls[1][1]
    expect(JSON.parse(second.body).data).toEqual(JSON.parse(first.body).data)
    expect(second.body).toBe(first.body)
    expect(second.headers).toEqual(first.headers)
    const { data, diagnostics } = JSON.parse(first.body)
    expect(data.attributes.source.sdk_name).toBe('browser')
    expect(diagnostics.sdk.name).toBeUndefined()
    expect(diagnostics.fetch).toMatchObject({ sequence: 1, trigger: 'initialization' })
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /private-user|private-attribute|secret-token|attempt|request_id|settings|rum/
    )
    const accepted = accept()
    expect(serializeRequestBody(payload, accepted.signal)).toContain(`${body.slice(0, -1)},"diagnostics":`)
    await provider.onClose()
  })

  it('counts equal-context fetches, never reads RUM, and leaves unowned requests unchanged', async () => {
    const getInternalContext = jest.fn(() => {
      throw new Error('not available')
    })
    rumGlobal.DD_RUM = { getInternalContext }
    const transport = jest
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(precomputedResponse))))
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: transport })
    await provider.initialize(context)
    await provider.onContextChange(context, context)
    expect(JSON.parse(transport.mock.calls[1][1].body).diagnostics.fetch).toMatchObject({
      sequence: 2,
      trigger: 'context_change',
    })
    expect(getInternalContext).not.toHaveBeenCalled()
    await provider.onClose()
    await fetchPrecomputedConfiguration({ ...options, context, fetch: transport })
    expect(JSON.parse(transport.mock.calls[2][1].body).diagnostics).toBeUndefined()
  })
})
