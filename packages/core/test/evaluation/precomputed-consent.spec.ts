import type { FlagsConfiguration, PrecomputedConfiguration } from '../../src/configuration'
import { encodePrecomputedFlagKey } from '../../src/configuration/flag-key-obfuscation'
import {
  configurationFromPrecomputedString,
  configurationToPrecomputedString,
} from '../../src/configuration/precomputed-wire'
import { configurationFromRulesString } from '../../src/configuration/rules-wire'
import { parsePrecomputedConfigurationResponse } from '../../src/configuration/wire-validation'
import { evaluate } from '../../src/evaluation/evaluation'
import { evaluatePrecomputedConfiguration } from '../../src/evaluation/precomputed-evaluation'

const metadataKey = '__dd_observe_full_evaluation_data'
const context = { targetingKey: 'subject' }
const encoding = { scheme: 'flag-key-sha256-v1' as const, salt: '000102030405060708090a0b0c0d0e0f' }

function configuration(
  consent: unknown,
  obfuscated = false
): FlagsConfiguration & { precomputed: PrecomputedConfiguration } {
  const encoded = encodePrecomputedFlagKey('flag', encoding)
  if ('error' in encoded) throw new Error(encoded.error)
  return {
    precomputed: {
      context,
      response: {
        data: {
          attributes: {
            createdAt: '2026-10-21T00:00:00Z',
            ...(consent === undefined ? {} : { observeFullEvaluationData: consent as boolean }),
            ...(obfuscated ? { obfuscated: true, obfuscation: encoding } : {}),
            flags: {
              [obfuscated ? encoded.key : 'flag']: {
                allocationKey: 'allocation',
                variationKey: 'on',
                variationType: 'boolean',
                variationValue: true,
                reason: 'STATIC',
                doLog: true,
              },
            },
          },
        },
      },
    },
  }
}

describe.each([false, true])('precomputed consent (obfuscated: %s)', (obfuscated) => {
  it.each([true, false, undefined, null, 'true', 1, [], { $serde_json: true }])(
    'accepts assignments and fails closed for consent %p through wire round trips',
    (consent) => {
      const config = configuration(consent, obfuscated)
      const input = config.precomputed.response
      const parsed = parsePrecomputedConfigurationResponse(input)
      expect(parsed).not.toHaveProperty('error')
      if ('error' in parsed) throw new Error(parsed.error)
      expect(parsed.response.data.attributes.observeFullEvaluationData).toBe(
        consent === undefined ? undefined : consent === true
      )
      // Parsing does not mutate the caller's response.
      expect(input.data.attributes.observeFullEvaluationData).toBe(consent)
      const restored = configurationFromPrecomputedString(configurationToPrecomputedString(config))
      for (const candidate of [config, restored]) {
        for (const evaluator of [evaluate, evaluatePrecomputedConfiguration]) {
          const result = evaluator(candidate, 'boolean', 'flag', false, context)
          expect(result).toMatchObject({
            value: true,
            reason: 'STATIC',
            variant: 'on',
            flagMetadata: {
              allocationKey: 'allocation',
              doLog: true,
              [metadataKey]: consent === true,
              __dd_eval_timestamp_ms: expect.any(Number),
            },
          })
          expect(evaluator(candidate, 'boolean', 'missing', false, context)).toMatchObject({
            value: false,
            errorCode: 'FLAG_NOT_FOUND',
            flagMetadata: { [metadataKey]: consent === true },
          })
          expect(evaluator(candidate, 'string', 'flag', 'default', context)).toMatchObject({
            value: 'default',
            errorCode: 'TYPE_MISMATCH',
            flagMetadata: { [metadataKey]: consent === true },
          })
        }
      }
    }
  )

  it.each([true, false])('preserves consent %s for malformed flag errors', (consent) => {
    const config = configuration(consent, obfuscated)
    const flags = config.precomputed.response.data.attributes.flags
    Object.values(flags)[0].variationValue = null as never
    const restored = configurationFromPrecomputedString(configurationToPrecomputedString(config))
    expect(evaluate(restored, 'boolean', 'flag', false, context)).toMatchObject({
      value: false,
      errorCode: 'PARSE_ERROR',
      flagMetadata: { [metadataKey]: consent },
    })
  })

  it.each([true, false])('retains consent %s on results across a consent-only replacement', (consent) => {
    let current = configuration(consent, obfuscated)
    const first = evaluate(current, 'boolean', 'flag', false, context)
    current = configuration(!consent, obfuscated)
    const second = evaluate(current, 'boolean', 'flag', false, context)
    expect(first.flagMetadata?.[metadataKey]).toBe(consent)
    expect(second.flagMetadata?.[metadataKey]).toBe(!consent)
    expect(second.value).toBe(first.value)
  })
})

describe.each([evaluate, evaluatePrecomputedConfiguration])('unusable configuration consent', (evaluator) => {
  it.each([
    ['PROVIDER_NOT_READY', undefined],
    ['PARSE_ERROR', {}],
    ['PARSE_ERROR', { configurationError: 'invalid' }],
    ['INVALID_CONTEXT', configuration(true)],
  ] as const)('defaults to false for %s', (errorCode, config) => {
    expect(evaluator(config, 'boolean', 'flag', false, { targetingKey: 'other' })).toMatchObject({
      value: false,
      errorCode,
      flagMetadata: { [metadataKey]: false, __dd_eval_timestamp_ms: expect.any(Number) },
    })
  })
})

it('uses the consent from the selected capability when rules and precomputed disagree', () => {
  const config = configuration(true)
  config.rules = configurationFromRulesString(JSON.stringify({ version: 1, rules: { response: 'EgRwcm9k' } })).rules
  expect(evaluate(config, 'boolean', 'flag', false, context).flagMetadata?.[metadataKey]).toBe(true)
  expect(evaluate(config, 'boolean', 'flag', false, { targetingKey: 'other' })).toMatchObject({
    errorCode: 'FLAG_NOT_FOUND',
    flagMetadata: { [metadataKey]: false },
  })
})
