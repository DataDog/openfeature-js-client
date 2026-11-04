import type { EvaluationContext, Logger } from '@openfeature/core'
import { evaluateForSubject, featuresWithPrefix, METADATA_FEATURE_PREFIX } from '../../src/evaluation'
import type { Flag } from '../../src/evaluation/ufc-v1'

describe('split features in flag metadata', () => {
  let logger: Logger

  beforeEach(() => {
    logger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    }
  })

  function flagWithFeatures(features: unknown): Flag {
    return {
      key: 'features-flag',
      enabled: true,
      variationType: 'BOOLEAN',
      variations: {
        'on-variation': { key: 'on-variation', value: true },
      },
      allocations: [
        {
          key: 'features-allocation',
          doLog: true,
          splits: [
            {
              variationKey: 'on-variation',
              shards: [{ salt: 'test-salt', ranges: [{ start: 0, end: 10000 }], totalShards: 10000 }],
              features,
            },
          ],
        },
      ],
    }
  }

  function evaluate(features: unknown) {
    const context: EvaluationContext = { targetingKey: 'user-123' }
    return evaluateForSubject(flagWithFeatures(features), 'boolean', 'user-123', context, false, logger)
  }

  function featureMetadataKeys(result: ReturnType<typeof evaluate>): string[] {
    return Object.keys(result.flagMetadata ?? {}).filter((key) => key.startsWith('__dd_'))
  }

  it('writes one metadata entry per feature and destination for mixed value types', () => {
    const result = evaluate([
      { key: 'holdout.key', value: '06ad', destinations: ['HOOK'] },
      { key: 'holdout.assignment_group', value: 'status_quo', destinations: ['HOOK', 'EXPOSURE'] },
      { key: 'holdout.should_include_in_holdout_analysis', value: false, destinations: ['HOOK'] },
      { key: 'holdout.ratio', value: 0.5, destinations: ['EVALUATION'] },
    ])

    expect(result.flagMetadata).toMatchObject({
      '__dd_feature.holdout.key': '06ad',
      '__dd_feature.holdout.assignment_group': 'status_quo',
      '__dd_feature.holdout.should_include_in_holdout_analysis': false,
      '__dd_exposure_feature.holdout.assignment_group': 'status_quo',
      '__dd_evaluation_feature.holdout.ratio': 0.5,
      __dd_has_evaluation_features: true,
    })
  })

  it('never fails the flag for a missing, non-list or malformed features field', () => {
    for (const features of [undefined, null, 'features', { key: 'holdout.key' }, [null, 42, 'flat']]) {
      const result = evaluate(features)
      expect(result.value).toBe(true)
      expect(result.reason).toBe('SPLIT')
      expect(featureMetadataKeys(result)).toEqual(
        expect.arrayContaining(['__dd_allocation_key', '__dd_do_log', '__dd_split_serial_id'])
      )
      expect(featureMetadataKeys(result).filter((key) => key.includes('feature.'))).toEqual([])
    }
  })

  it('skips a feature with an unsupported value type', () => {
    const result = evaluate([
      { key: 'holdout.key', value: { nested: true }, destinations: ['HOOK'] },
      { key: 'holdout.key', value: ['a'], destinations: ['HOOK'] },
      { key: 'holdout.key', value: null, destinations: ['HOOK'] },
    ])

    expect(result.flagMetadata?.['__dd_feature.holdout.key']).toBeUndefined()
  })

  it('ignores an unknown destination and warns once per distinct value', () => {
    const result = evaluate([
      { key: 'holdout.key', value: '06ad', destinations: ['TARIFF'] },
      { key: 'holdout.other', value: '06ad', destinations: ['TARIFF', 'HOOK'] },
    ])

    expect(result.flagMetadata?.['__dd_feature.holdout.other']).toBe('06ad')
    expect(featureMetadataKeys(result).filter((key) => key.startsWith('__dd_feature.holdout.key'))).toEqual([])
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('Ignoring unknown feature destination TARIFF')
  })

  it('keeps the first valid feature for a repeated key, for every destination', () => {
    const result = evaluate([
      { key: 'holdout.key', value: 'first', destinations: ['HOOK', 'EXPOSURE'] },
      { key: 'holdout.key', value: 'second', destinations: ['HOOK'] },
    ])

    expect(result.flagMetadata?.['__dd_feature.holdout.key']).toBe('first')
    expect(result.flagMetadata?.['__dd_exposure_feature.holdout.key']).toBe('first')
  })

  it('lets a later valid feature win when earlier entries with the same key are invalid', () => {
    const result = evaluate([
      { key: 'holdout.key', value: null, destinations: ['HOOK'] },
      { key: 'holdout.key', value: 'valid', destinations: ['HOOK'] },
    ])

    expect(result.flagMetadata?.['__dd_feature.holdout.key']).toBe('valid')
  })

  it('drops a feature whose destinations list is empty or has no strings', () => {
    const result = evaluate([
      { key: 'holdout.key', value: '06ad', destinations: [] },
      { key: 'holdout.other', value: '06ad', destinations: [1, null] },
      { key: 'holdout.third', value: '06ad', destinations: 'HOOK' },
    ])

    expect(featureMetadataKeys(result).filter((key) => key.includes('feature.'))).toEqual([])
  })

  it('sets __dd_has_evaluation_features only for EVALUATION destinations', () => {
    const hookOnly = evaluate([{ key: 'holdout.key', value: '06ad', destinations: ['HOOK'] }])
    expect(hookOnly.flagMetadata?.__dd_has_evaluation_features).toBeUndefined()

    const evaluation = evaluate([{ key: 'holdout.key', value: '06ad', destinations: ['EVALUATION'] }])
    expect(evaluation.flagMetadata?.__dd_has_evaluation_features).toBe(true)
  })

  it('adds no metadata entries for a split without features', () => {
    const result = evaluate(undefined)
    expect(featureMetadataKeys(result)).toEqual(
      expect.arrayContaining(['__dd_allocation_key', '__dd_do_log', '__dd_split_serial_id'])
    )
    expect(featureMetadataKeys(result).filter((key) => key.includes('feature.'))).toEqual([])
    expect(result.flagMetadata?.__dd_has_evaluation_features).toBeUndefined()
  })

  it('warns about at most 64 distinct unknown destinations', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createSplitFeatureMetadata: freshCreate } = require('../../src/evaluation/split-features')
      const warn = jest.fn()
      const features = Array.from({ length: 70 }, (_, index) => ({
        key: `holdout.key-${index}`,
        value: '06ad',
        destinations: [`UNKNOWN-${index}`],
      }))
      const result = freshCreate(features, { warn, debug: () => {}, info: () => {}, error: () => {} })
      expect(Object.keys(result.entries)).toEqual([])
      expect(warn).toHaveBeenCalledTimes(64)
    })
  })

  it('preserves a valid __proto__ feature key', () => {
    const result = evaluate([{ key: '__proto__', value: 'holdout', destinations: ['HOOK'] }])
    const features = featuresWithPrefix(result.flagMetadata, METADATA_FEATURE_PREFIX)
    // biome-ignore lint/suspicious/noPrototypeBuiltins: the test targets this exact property.
    expect(Object.prototype.hasOwnProperty.call(features, '__proto__')).toBe(true)
    expect(features?.__proto__).toBe('holdout')
  })
})
