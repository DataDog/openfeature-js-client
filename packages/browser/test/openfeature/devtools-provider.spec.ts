import type { EvaluationContext, Hook, Logger, Provider } from '@openfeature/web-sdk'
import { OpenFeatureEventEmitter, ProviderStatus, TypeMismatchError } from '@openfeature/web-sdk'
import { DatadogDevtools } from '../../src/openfeature/devtools-provider'

const OVERRIDES_KEY = 'dd.dd_flag.overrides'
const DEVTOOLS_MARKER_KEY = 'dd.dd_flag.devtools'

const noopLogger = {} as Logger
const emptyContext: EvaluationContext = {}

function makeInner(overrides: Partial<Provider> = {}): jest.Mocked<Provider> {
  return {
    metadata: { name: 'mock-inner' },
    runsOn: 'client',
    hooks: [],
    events: new OpenFeatureEventEmitter(),
    initialize: jest.fn().mockResolvedValue(undefined),
    onClose: jest.fn().mockResolvedValue(undefined),
    onContextChange: jest.fn().mockResolvedValue(undefined),
    resolveBooleanEvaluation: jest.fn().mockReturnValue({ value: false, reason: 'DEFAULT' }),
    resolveStringEvaluation: jest.fn().mockReturnValue({ value: 'inner-default', reason: 'DEFAULT' }),
    resolveNumberEvaluation: jest.fn().mockReturnValue({ value: 0, reason: 'DEFAULT' }),
    resolveObjectEvaluation: jest.fn().mockReturnValue({ value: {}, reason: 'DEFAULT' }),
    ...overrides,
  } as jest.Mocked<Provider>
}

function setOverrides(overrides: Record<string, unknown>) {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides))
}

describe('DatadogDevtools', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('initialization', () => {
    it('loads overrides from localStorage once on initialize', async () => {
      setOverrides({ 'my-flag': { type: 'BOOLEAN', value: true } })
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      const getItemSpy = jest.spyOn(Storage.prototype, 'getItem')

      await wrapper.initialize(emptyContext)
      const readsAfterInit = getItemSpy.mock.calls.length

      // Overwrite localStorage after init — should not affect in-memory overrides
      localStorage.setItem(OVERRIDES_KEY, JSON.stringify({ 'my-flag': { type: 'BOOLEAN', value: false } }))

      wrapper.resolveBooleanEvaluation('my-flag', false, emptyContext, noopLogger)
      wrapper.resolveBooleanEvaluation('my-flag', false, emptyContext, noopLogger)
      wrapper.resolveBooleanEvaluation('my-flag', false, emptyContext, noopLogger)

      // No additional localStorage reads after init
      expect(getItemSpy).toHaveBeenCalledTimes(readsAfterInit)
      // And the cached value (true) is used, not the overwritten one (false)
      expect(wrapper.resolveBooleanEvaluation('my-flag', false, emptyContext, noopLogger).value).toBe(true)

      getItemSpy.mockRestore()
    })

    it('writes the devtools enablement marker to localStorage', async () => {
      const wrapper = new DatadogDevtools(makeInner())
      await wrapper.initialize(emptyContext)
      expect(localStorage.getItem(DEVTOOLS_MARKER_KEY)).toBe('enabled')
    })

    it('delegates initialize to the inner provider with the same context', async () => {
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      const context = { targetingKey: 'user-1' }

      await wrapper.initialize(context)

      expect(inner.initialize).toHaveBeenCalledWith(context)
    })

    it('does not crash when localStorage is unavailable during initialize', async () => {
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('storage unavailable')
      })

      const wrapper = new DatadogDevtools(makeInner())
      await expect(wrapper.initialize(emptyContext)).resolves.toBeUndefined()

      jest.restoreAllMocks()
    })

    it('falls back to empty overrides when localStorage contains malformed JSON', async () => {
      localStorage.setItem(OVERRIDES_KEY, 'not-valid-json}}}')
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      const result = wrapper.resolveBooleanEvaluation('my-flag', false, emptyContext, noopLogger)

      // miss → delegates to inner
      expect(inner.resolveBooleanEvaluation).toHaveBeenCalled()
      expect(result).toEqual({ value: false, reason: 'DEFAULT' })
    })
  })

  describe('lifecycle delegation', () => {
    it('forwards onContextChange to inner provider', async () => {
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      const old = { targetingKey: 'user-1' }
      const next = { targetingKey: 'user-2' }

      await wrapper.onContextChange?.(old, next)

      expect(inner.onContextChange).toHaveBeenCalledWith(old, next)
    })

    it('removes the devtools marker and calls inner onClose', async () => {
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)
      expect(localStorage.getItem(DEVTOOLS_MARKER_KEY)).toBe('enabled')

      await wrapper.onClose?.()

      expect(localStorage.getItem(DEVTOOLS_MARKER_KEY)).toBeNull()
      expect(inner.onClose).toHaveBeenCalled()
    })

    it('exposes inner provider hooks', () => {
      const hooks: Hook[] = []
      const inner = makeInner({ hooks })
      const wrapper = new DatadogDevtools(inner)
      expect(wrapper.hooks).toBe(hooks)
    })

    it('exposes inner provider events', () => {
      const events = new OpenFeatureEventEmitter()
      const inner = makeInner({ events })
      const wrapper = new DatadogDevtools(inner)
      expect(wrapper.events).toBe(events)
    })

    it('exposes inner provider status', () => {
      const inner = makeInner({ status: ProviderStatus.READY })
      const wrapper = new DatadogDevtools(inner)
      expect(wrapper.status).toBe(ProviderStatus.READY)
    })
  })

  describe('override hit — returns override, does not call inner', () => {
    beforeEach(async () => {
      setOverrides({
        'bool-flag': { type: 'BOOLEAN', value: true },
        'str-flag': { type: 'STRING', value: 'override-value' },
        'int-flag': { type: 'INTEGER', value: 42 },
        'num-flag': { type: 'NUMERIC', value: 3.14 },
        'json-flag': { type: 'JSON', value: { nested: true } },
      })
    })

    it('returns BOOLEAN override', async () => {
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      const result = wrapper.resolveBooleanEvaluation('bool-flag', false, emptyContext, noopLogger)

      expect(result).toEqual({ value: true, reason: 'STATIC', flagMetadata: { overridden: true } })
      expect(inner.resolveBooleanEvaluation).not.toHaveBeenCalled()
    })

    it('returns STRING override', async () => {
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      const result = wrapper.resolveStringEvaluation('str-flag', 'default', emptyContext, noopLogger)

      expect(result).toEqual({ value: 'override-value', reason: 'STATIC', flagMetadata: { overridden: true } })
      expect(inner.resolveStringEvaluation).not.toHaveBeenCalled()
    })

    it('returns INTEGER override', async () => {
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      const result = wrapper.resolveNumberEvaluation('int-flag', 0, emptyContext, noopLogger)

      expect(result).toEqual({ value: 42, reason: 'STATIC', flagMetadata: { overridden: true } })
      expect(inner.resolveNumberEvaluation).not.toHaveBeenCalled()
    })

    it('returns NUMERIC override', async () => {
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      const result = wrapper.resolveNumberEvaluation('num-flag', 0, emptyContext, noopLogger)

      expect(result).toEqual({ value: 3.14, reason: 'STATIC', flagMetadata: { overridden: true } })
      expect(inner.resolveNumberEvaluation).not.toHaveBeenCalled()
    })

    it('returns JSON override', async () => {
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      const result = wrapper.resolveObjectEvaluation('json-flag', {}, emptyContext, noopLogger)

      expect(result).toEqual({ value: { nested: true }, reason: 'STATIC', flagMetadata: { overridden: true } })
      expect(inner.resolveObjectEvaluation).not.toHaveBeenCalled()
    })

    it('returns BOOLEAN override with value false (falsy)', async () => {
      setOverrides({ 'bool-flag': { type: 'BOOLEAN', value: false } })
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      const result = wrapper.resolveBooleanEvaluation('bool-flag', true, emptyContext, noopLogger)

      expect(result).toEqual({ value: false, reason: 'STATIC', flagMetadata: { overridden: true } })
      expect(inner.resolveBooleanEvaluation).not.toHaveBeenCalled()
    })

    it('returns NUMERIC override with value 0 (falsy)', async () => {
      setOverrides({ 'num-flag': { type: 'NUMERIC', value: 0 } })
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      const result = wrapper.resolveNumberEvaluation('num-flag', 99, emptyContext, noopLogger)

      expect(result).toEqual({ value: 0, reason: 'STATIC', flagMetadata: { overridden: true } })
      expect(inner.resolveNumberEvaluation).not.toHaveBeenCalled()
    })

    it('rejects JSON override with null value', async () => {
      setOverrides({ 'json-flag': { type: 'JSON', value: null } })
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      expect(() => wrapper.resolveObjectEvaluation('json-flag', {}, emptyContext, noopLogger)).toThrow()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'json-flag'"))
      warnSpy.mockRestore()
    })

    it('handles multiple coexisting overrides independently', async () => {
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      expect(wrapper.resolveBooleanEvaluation('bool-flag', false, emptyContext, noopLogger).value).toBe(true)
      expect(wrapper.resolveStringEvaluation('str-flag', '', emptyContext, noopLogger).value).toBe('override-value')
      expect(inner.resolveBooleanEvaluation).not.toHaveBeenCalled()
      expect(inner.resolveStringEvaluation).not.toHaveBeenCalled()
    })
  })

  describe('override miss — delegates to inner provider', () => {
    it('delegates boolean evaluation when no override exists', async () => {
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      const result = wrapper.resolveBooleanEvaluation('unknown-flag', false, emptyContext, noopLogger)

      expect(inner.resolveBooleanEvaluation).toHaveBeenCalledWith('unknown-flag', false, emptyContext, noopLogger)
      expect(result).toEqual({ value: false, reason: 'DEFAULT' })
    })

    it('delegates string evaluation when no override exists', async () => {
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      wrapper.resolveStringEvaluation('unknown-flag', 'default', emptyContext, noopLogger)

      expect(inner.resolveStringEvaluation).toHaveBeenCalledWith('unknown-flag', 'default', emptyContext, noopLogger)
    })

    it('delegates number evaluation when no override exists', async () => {
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      wrapper.resolveNumberEvaluation('unknown-flag', 0, emptyContext, noopLogger)

      expect(inner.resolveNumberEvaluation).toHaveBeenCalledWith('unknown-flag', 0, emptyContext, noopLogger)
    })

    it('delegates object evaluation when no override exists', async () => {
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      wrapper.resolveObjectEvaluation('unknown-flag', {}, emptyContext, noopLogger)

      expect(inner.resolveObjectEvaluation).toHaveBeenCalledWith('unknown-flag', {}, emptyContext, noopLogger)
    })

    it('delegates when override type does not match the requested type', async () => {
      // STRING override, but resolveBoolean is called — type mismatch at the selection level, not value level
      setOverrides({ 'my-flag': { type: 'STRING', value: 'hello' } })
      const inner = makeInner()
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      wrapper.resolveBooleanEvaluation('my-flag', false, emptyContext, noopLogger)

      expect(inner.resolveBooleanEvaluation).toHaveBeenCalled()
    })

    it('propagates inner provider errors on miss', async () => {
      const inner = makeInner({
        resolveBooleanEvaluation: jest.fn().mockImplementation(() => {
          throw new Error('inner error')
        }),
      })
      const wrapper = new DatadogDevtools(inner)
      await wrapper.initialize(emptyContext)

      expect(() => wrapper.resolveBooleanEvaluation('unknown-flag', false, emptyContext, noopLogger)).toThrow(
        'inner error'
      )
    })
  })

  describe('type validation — TypeMismatchError', () => {
    let warnSpy: jest.SpyInstance

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warnSpy.mockRestore()
    })

    it('throws TypeMismatchError and warns for BOOLEAN override with non-boolean value', async () => {
      setOverrides({ 'my-flag': { type: 'BOOLEAN', value: 'yes' } })
      const wrapper = new DatadogDevtools(makeInner())
      await wrapper.initialize(emptyContext)

      expect(() => wrapper.resolveBooleanEvaluation('my-flag', false, emptyContext, noopLogger)).toThrow(
        TypeMismatchError
      )
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'my-flag'"))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('override ignored'))
    })

    it('throws TypeMismatchError and warns for STRING override with non-string value', async () => {
      setOverrides({ 'my-flag': { type: 'STRING', value: 123 } })
      const wrapper = new DatadogDevtools(makeInner())
      await wrapper.initialize(emptyContext)

      expect(() => wrapper.resolveStringEvaluation('my-flag', 'default', emptyContext, noopLogger)).toThrow(
        TypeMismatchError
      )
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'my-flag'"))
    })

    it('throws TypeMismatchError and warns for INTEGER override with non-number value', async () => {
      setOverrides({ 'my-flag': { type: 'INTEGER', value: 'not-a-number' } })
      const wrapper = new DatadogDevtools(makeInner())
      await wrapper.initialize(emptyContext)

      expect(() => wrapper.resolveNumberEvaluation('my-flag', 0, emptyContext, noopLogger)).toThrow(TypeMismatchError)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'my-flag'"))
    })

    it('throws TypeMismatchError and warns for INTEGER override with float value', async () => {
      setOverrides({ 'my-flag': { type: 'INTEGER', value: 3.14 } })
      const wrapper = new DatadogDevtools(makeInner())
      await wrapper.initialize(emptyContext)

      expect(() => wrapper.resolveNumberEvaluation('my-flag', 0, emptyContext, noopLogger)).toThrow(TypeMismatchError)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a whole number'))
    })

    it('throws TypeMismatchError and warns for NUMERIC override with non-number value', async () => {
      setOverrides({ 'my-flag': { type: 'NUMERIC', value: true } })
      const wrapper = new DatadogDevtools(makeInner())
      await wrapper.initialize(emptyContext)

      expect(() => wrapper.resolveNumberEvaluation('my-flag', 0, emptyContext, noopLogger)).toThrow(TypeMismatchError)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'my-flag'"))
    })

    it('throws TypeMismatchError and warns for JSON override with non-object value', async () => {
      setOverrides({ 'my-flag': { type: 'JSON', value: 'not-an-object' } })
      const wrapper = new DatadogDevtools(makeInner())
      await wrapper.initialize(emptyContext)

      expect(() => wrapper.resolveObjectEvaluation('my-flag', {}, emptyContext, noopLogger)).toThrow(TypeMismatchError)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'my-flag'"))
    })
  })
})
