import { createDebugLogger, debugOptions, debugUrl, NO_DEBUG } from '../src/debug'

function records(log: jest.SpyInstance) {
  return log.mock.calls.map(([line]) => JSON.parse(String(line).slice('[Datadog Feature Flags] '.length)))
}

describe('local flag debug logger', () => {
  let log: jest.SpyInstance
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  it('is opt-in and does not construct disabled payloads', () => {
    const fields = jest.fn(() => {
      throw new Error('must not run')
    })
    expect(createDebugLogger(undefined)).toBe(NO_DEBUG)
    createDebugLogger(false).event('ignored', fields)
    expect(fields).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('snapshots full raw data without calling getters or toJSON', () => {
    const debug = createDebugLogger(true)
    const getter = jest.fn(() => {
      throw new Error('getter')
    })
    const toJSON = jest.fn(() => {
      throw new Error('toJSON')
    })
    const context = {
      targetingKey: 'customer@example.com',
      token: 'targeting-attribute',
      nested: { value: 'before' },
      toJSON,
    }
    Object.defineProperty(context, 'computed', { get: getter, enumerable: true })
    debug.event('raw', () => ({ context, undefinedValue: undefined, bigint: BigInt(4), map: new Map([['a', 1]]) }))
    context.nested.value = 'after'
    expect(getter).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
    expect(records(log).slice(-1)[0].details).toMatchObject({
      context: {
        targetingKey: 'customer@example.com',
        token: 'targeting-attribute',
        nested: { value: 'before' },
        computed: { $type: 'accessor' },
      },
      undefinedValue: { $type: 'undefined' },
      bigint: { $type: 'bigint', value: '4' },
      map: { $type: 'map', entries: [['a', 1]] },
    })
  })

  it('handles cycles and restores reentrancy guards after a throwing sink', () => {
    const debug = createDebugLogger(true)
    const circular: { self?: unknown } = {}
    circular.self = circular
    debug.event('circular', () => circular)
    expect(records(log).slice(-1)[0].details.self).toEqual({ $type: 'circular' })
    log.mockImplementation(() => {
      throw new Error('sink unavailable')
    })
    expect(() => debug.event('ignored')).not.toThrow()
    log.mockImplementation(() => {})
    debug.event('recovered')
    expect(records(log).slice(-1)[0].event).toBe('recovered')
  })

  it('does not recursively emit through console interceptors', () => {
    const debug = createDebugLogger(true)
    log.mockClear()
    log.mockImplementation(() => debug.event('recursive'))
    debug.event('outer')
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('contains failing diagnostic factories', () => {
    const debug = createDebugLogger(true)
    expect(() =>
      debug.event('failure', () => {
        throw new Error('diagnostic only')
      })
    ).not.toThrow()
    expect(records(log).slice(-1)[0].event).toBe('debug.serialization_or_sink_failed')
  })

  it('chunks rather than truncates large values', () => {
    const debug = createDebugLogger(true)
    log.mockClear()
    const value = '🦆raw'.repeat(20000)
    debug.event('large', () => ({ value }))
    const chunks = records(log)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.event === 'debug.chunk')).toBe(true)
    expect(JSON.parse(chunks.map((chunk) => chunk.data).join('')).details.value).toBe(value)
  })

  it('omits transport credential values while retaining raw targeting data', () => {
    const options = debugOptions({
      clientToken: 'client-secret',
      customHeaders: { Authorization: 'bearer-secret', 'X-Custom': 'header-value' },
      flaggingProxy: 'https://user:password@example.com/config?api_key=key-secret&env=prod',
      initialFlagsConfiguration: { context: { password: 'raw-targeting-value' } },
    })
    const serialized = JSON.stringify(options)
    for (const secret of ['client-secret', 'bearer-secret', 'header-value', 'key-secret', 'user:password'])
      expect(serialized).not.toContain(secret)
    expect(serialized).toContain('raw-targeting-value')
    expect(debugUrl('/path?dd-api-key=secret&dd_env=prod')).not.toContain('=secret')
  })

  it('isolates provider identities and preserves original logger calls', () => {
    const a = createDebugLogger(true)
    const b = createDebugLogger(true)
    expect(a.instanceId).not.toBe(b.instanceId)
    const original = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    a.child({ evaluationId: 2 }).logger(original).debug('trace', { value: true })
    expect(original.debug).toHaveBeenCalledWith('trace', { value: true })
    expect(records(log).slice(-1)[0]).toMatchObject({
      providerInstanceId: a.instanceId,
      evaluationId: 2,
      event: 'evaluation.trace',
    })
  })
})
