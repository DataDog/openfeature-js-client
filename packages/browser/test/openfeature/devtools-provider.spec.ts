import { FlagNotFoundError, TypeMismatchError } from '@openfeature/web-sdk'
import { DevToolsProvider } from '../../src/openfeature/devtools-provider'

const OVERRIDES_KEY = 'dd.dd_flag.overrides'
const DEVTOOLS_MARKER_KEY = 'dd.dd_flag.devtools'

const DUMMY_CONTEXT = {}
const DUMMY_LOGGER = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }

function setOverrides(overrides: Record<string, unknown>) {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides))
}

describe('DevToolsProvider', () => {
  let provider: DevToolsProvider

  beforeEach(async () => {
    localStorage.clear()
    provider = new DevToolsProvider()
    await provider.initialize()
  })

  describe('initialize', () => {
    it('writes the enablement marker to localStorage', () => {
      expect(localStorage.getItem(DEVTOOLS_MARKER_KEY)).toBe('enabled')
    })
  })

  describe('resolveBooleanEvaluation', () => {
    it('returns the override value when a BOOLEAN override exists', () => {
      setOverrides({ 'my-flag': { type: 'BOOLEAN', value: true } })
      const result = provider.resolveBooleanEvaluation('my-flag', false, DUMMY_CONTEXT, DUMMY_LOGGER)
      expect(result.value).toBe(true)
      expect(result.reason).toBe('STATIC')
      expect(result.flagMetadata?.overridden).toBe(true)
    })

    it('throws FlagNotFoundError when no override exists', () => {
      expect(() => provider.resolveBooleanEvaluation('missing-flag', false, DUMMY_CONTEXT, DUMMY_LOGGER)).toThrow(
        FlagNotFoundError
      )
    })

    it('throws FlagNotFoundError when override type does not match', () => {
      setOverrides({ 'my-flag': { type: 'STRING', value: 'hello' } })
      expect(() => provider.resolveBooleanEvaluation('my-flag', false, DUMMY_CONTEXT, DUMMY_LOGGER)).toThrow(
        FlagNotFoundError
      )
    })

    it('throws TypeMismatchError when declared type is BOOLEAN but value is not a boolean', () => {
      setOverrides({ 'my-flag': { type: 'BOOLEAN', value: 'yes' } })
      expect(() => provider.resolveBooleanEvaluation('my-flag', false, DUMMY_CONTEXT, DUMMY_LOGGER)).toThrow(
        TypeMismatchError
      )
    })
  })

  describe('resolveStringEvaluation', () => {
    it('returns the override value when a STRING override exists', () => {
      setOverrides({ 'my-flag': { type: 'STRING', value: 'override-value' } })
      const result = provider.resolveStringEvaluation('my-flag', 'default', DUMMY_CONTEXT, DUMMY_LOGGER)
      expect(result.value).toBe('override-value')
      expect(result.reason).toBe('STATIC')
      expect(result.flagMetadata?.overridden).toBe(true)
    })

    it('throws FlagNotFoundError when no override exists', () => {
      expect(() => provider.resolveStringEvaluation('missing-flag', 'default', DUMMY_CONTEXT, DUMMY_LOGGER)).toThrow(
        FlagNotFoundError
      )
    })

    it('throws TypeMismatchError when declared type is STRING but value is not a string', () => {
      setOverrides({ 'my-flag': { type: 'STRING', value: 123 } })
      expect(() => provider.resolveStringEvaluation('my-flag', '', DUMMY_CONTEXT, DUMMY_LOGGER)).toThrow(
        TypeMismatchError
      )
    })
  })

  describe('resolveNumberEvaluation', () => {
    it('returns the override value when an INTEGER override exists', () => {
      setOverrides({ 'my-flag': { type: 'INTEGER', value: 42 } })
      const result = provider.resolveNumberEvaluation('my-flag', 0, DUMMY_CONTEXT, DUMMY_LOGGER)
      expect(result.value).toBe(42)
      expect(result.reason).toBe('STATIC')
      expect(result.flagMetadata?.overridden).toBe(true)
    })

    it('returns the override value when a NUMERIC override exists', () => {
      setOverrides({ 'my-flag': { type: 'NUMERIC', value: 3.14 } })
      const result = provider.resolveNumberEvaluation('my-flag', 0, DUMMY_CONTEXT, DUMMY_LOGGER)
      expect(result.value).toBe(3.14)
      expect(result.reason).toBe('STATIC')
      expect(result.flagMetadata?.overridden).toBe(true)
    })

    it('throws FlagNotFoundError when no override exists', () => {
      expect(() => provider.resolveNumberEvaluation('missing-flag', 0, DUMMY_CONTEXT, DUMMY_LOGGER)).toThrow(
        FlagNotFoundError
      )
    })

    it('throws TypeMismatchError when declared type is INTEGER but value is a float', () => {
      setOverrides({ 'my-flag': { type: 'INTEGER', value: 3.14 } })
      expect(() => provider.resolveNumberEvaluation('my-flag', 0, DUMMY_CONTEXT, DUMMY_LOGGER)).toThrow(
        TypeMismatchError
      )
    })

    it('throws TypeMismatchError when declared type is NUMERIC but value is not a number', () => {
      setOverrides({ 'my-flag': { type: 'NUMERIC', value: 'not-a-number' } })
      expect(() => provider.resolveNumberEvaluation('my-flag', 0, DUMMY_CONTEXT, DUMMY_LOGGER)).toThrow(
        TypeMismatchError
      )
    })
  })

  describe('resolveObjectEvaluation', () => {
    it('returns the override value when a JSON object override exists', () => {
      const jsonValue = { variant: 'control', threshold: 0.5 }
      setOverrides({ 'my-flag': { type: 'JSON', value: jsonValue } })
      const result = provider.resolveObjectEvaluation('my-flag', {}, DUMMY_CONTEXT, DUMMY_LOGGER)
      expect(result.value).toEqual(jsonValue)
      expect(result.reason).toBe('STATIC')
      expect(result.flagMetadata?.overridden).toBe(true)
    })

    it('returns the override value when a JSON array override exists', () => {
      const jsonArray = [1, 'two', { three: 3 }]
      setOverrides({ 'my-flag': { type: 'JSON', value: jsonArray } })
      const result = provider.resolveObjectEvaluation('my-flag', {}, DUMMY_CONTEXT, DUMMY_LOGGER)
      expect(result.value).toEqual(jsonArray)
    })

    it('throws FlagNotFoundError when no override exists', () => {
      expect(() => provider.resolveObjectEvaluation('missing-flag', {}, DUMMY_CONTEXT, DUMMY_LOGGER)).toThrow(
        FlagNotFoundError
      )
    })

    it('throws TypeMismatchError when declared type is JSON but value is a string', () => {
      setOverrides({ 'my-flag': { type: 'JSON', value: 'not-an-object' } })
      expect(() => provider.resolveObjectEvaluation('my-flag', {}, DUMMY_CONTEXT, DUMMY_LOGGER)).toThrow(
        TypeMismatchError
      )
    })
  })

  describe('override storage edge cases', () => {
    it('throws FlagNotFoundError when localStorage is empty', () => {
      expect(() => provider.resolveBooleanEvaluation('any-flag', false, DUMMY_CONTEXT, DUMMY_LOGGER)).toThrow(
        FlagNotFoundError
      )
    })

    it('throws FlagNotFoundError when localStorage contains malformed JSON', () => {
      localStorage.setItem(OVERRIDES_KEY, 'not-valid-json')
      expect(() => provider.resolveBooleanEvaluation('any-flag', false, DUMMY_CONTEXT, DUMMY_LOGGER)).toThrow(
        FlagNotFoundError
      )
    })

    it('handles multiple overrides and returns the correct one', () => {
      setOverrides({
        'flag-a': { type: 'BOOLEAN', value: true },
        'flag-b': { type: 'STRING', value: 'hello' },
        'flag-c': { type: 'INTEGER', value: 7 },
        'flag-d': { type: 'NUMERIC', value: 1.5 },
        'flag-e': { type: 'JSON', value: { key: 'value' } },
      })
      expect(provider.resolveBooleanEvaluation('flag-a', false, DUMMY_CONTEXT, DUMMY_LOGGER).value).toBe(true)
      expect(provider.resolveStringEvaluation('flag-b', '', DUMMY_CONTEXT, DUMMY_LOGGER).value).toBe('hello')
      expect(provider.resolveNumberEvaluation('flag-c', 0, DUMMY_CONTEXT, DUMMY_LOGGER).value).toBe(7)
      expect(provider.resolveNumberEvaluation('flag-d', 0, DUMMY_CONTEXT, DUMMY_LOGGER).value).toBe(1.5)
      expect(provider.resolveObjectEvaluation('flag-e', {}, DUMMY_CONTEXT, DUMMY_LOGGER).value).toEqual({
        key: 'value',
      })
    })
  })
})
