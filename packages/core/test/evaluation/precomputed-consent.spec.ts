import type { FlagsConfiguration, PrecomputedConfiguration } from '../../src/configuration'
import { encodePrecomputedFlagKey } from '../../src/configuration/flag-key-obfuscation'
import {
  configurationFromPrecomputedString,
  configurationToPrecomputedString,
} from '../../src/configuration/precomputed-wire'
import { configurationFromRulesString } from '../../src/configuration/rules-wire'
import { parsePrecomputedConfigurationResponse } from '../../src/configuration/wire-validation'
import { evaluate } from '../../src/evaluation/evaluation'
import type { ExperimentationOptOutOption } from '../../src/evaluation/experimentation-opt-out'
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

// Both public evaluation paths must combine the opt-out policy with the consent
// of the configuration actually used, including when that configuration is rejected.
describe.each([
  [
    'combined',
    (config: FlagsConfiguration, subject: typeof context, mode: ExperimentationOptOutOption) =>
      evaluate(config, 'boolean', 'flag', false, subject, undefined, mode),
  ],
  [
    'precomputed',
    (config: FlagsConfiguration, subject: typeof context, mode: ExperimentationOptOutOption) =>
      evaluatePrecomputedConfiguration(config, 'boolean', 'flag', false, subject, mode),
  ],
] as const)('%s evaluation consent with experimentation opt-out', (_name, evaluator) => {
  const cutoff = '2026-10-21T00:00:00Z'
  const optedOutContext = { ...context, dd_experimentation_opt_out_at: cutoff }

  it.each(['immediate', 'future_experiments_only'] as const)(
    'preserves consent and acknowledged %s policy through a configuration round trip',
    (mode) => {
      for (const consent of [true, false]) {
        const config = configuration(consent)
        config.precomputed.context = optedOutContext
        const options = {
          experimentation_opt_out: true,
          experimentation_opt_out_mode: mode,
          dd_experimentation_opt_out_at: cutoff,
        }
        config.precomputed.response.data.attributes.evaluation_options = options
        const restored = configurationFromPrecomputedString(configurationToPrecomputedString(config))
        expect(restored.precomputed?.response.data.attributes.evaluation_options).toEqual(options)
        expect(evaluator(restored, optedOutContext, mode)).toMatchObject({
          value: true,
          flagMetadata: { [metadataKey]: consent, __dd_eval_timestamp_ms: expect.any(Number) },
        })
      }
    }
  )

  it.each(['invalid timestamp', 'missing acknowledgement', 'wrong cutoff', 'missing subject', 'disabled policy'])(
    'defaults consent to false when rejecting a configuration with %s',
    (scenario) => {
      const config = configuration(true)
      const subject = { ...optedOutContext }
      let mode: ExperimentationOptOutOption = 'future_experiments_only'
      config.precomputed.context = subject
      const options = {
        experimentation_opt_out: true,
        experimentation_opt_out_mode: 'future_experiments_only',
        dd_experimentation_opt_out_at: cutoff,
      }
      config.precomputed.response.data.attributes.evaluation_options = options
      if (scenario === 'invalid timestamp') subject.dd_experimentation_opt_out_at = 'invalid'
      if (scenario === 'missing acknowledgement') delete config.precomputed.response.data.attributes.evaluation_options
      if (scenario === 'wrong cutoff') {
        options.dd_experimentation_opt_out_at = '2026-10-20T00:00:00Z'
      }
      if (scenario === 'missing subject') delete config.precomputed.context
      if (scenario === 'disabled policy') mode = 'disabled'
      expect(evaluator(config, subject, mode)).toMatchObject({
        value: false,
        errorCode: 'INVALID_CONTEXT',
        flagMetadata: { [metadataKey]: false, __dd_eval_timestamp_ms: expect.any(Number) },
      })
    }
  )
})
