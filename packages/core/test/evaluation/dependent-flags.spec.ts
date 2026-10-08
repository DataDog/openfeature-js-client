import type { Logger } from '@openfeature/core'
import {
  type DependencyEvaluation,
  evaluateRulesBasedConfiguration,
  type Flag,
  type UniversalFlagConfigurationV1,
} from '../../src/evaluation'
import { matchesRule, OperatorType } from '../../src/evaluation/rules'

describe('dependent flag evaluation', () => {
  let logger: Logger

  beforeEach(() => {
    logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
  })

  it('evaluates varying depths with one timestamp and omitted variant_key property', () => {
    const config = configuration({
      root: dependentBooleanFlag('root', [flagCondition('middle', OperatorType.ONE_OF, ['on'])]),
      middle: dependentBooleanFlag('middle', [flagCondition('leaf', OperatorType.MATCHES, '^o[n]$')]),
      leaf: booleanFlag('leaf', 'on'),
    })
    config.observeFullEvaluationData = true
    const dependencies: DependencyEvaluation[] = []

    const result = evaluate(config, 'root', logger, (evaluation) => dependencies.push(evaluation))

    expect(result).toMatchObject({ value: true, variant: 'on' })
    expect(dependencies.map(({ flagKey }) => flagKey)).toEqual(['leaf', 'middle'])
    expect(dependencies.map(({ details }) => details.flagMetadata?.__dd_eval_timestamp_ms)).toEqual([
      result.flagMetadata?.__dd_eval_timestamp_ms,
      result.flagMetadata?.__dd_eval_timestamp_ms,
    ])
    expect(dependencies.map(({ details }) => details.flagMetadata?.__dd_observe_full_evaluation_data)).toEqual([
      true,
      true,
    ])
  })

  it.each([
    [OperatorType.ONE_OF, ['on']],
    [OperatorType.NOT_ONE_OF, ['off']],
    [OperatorType.MATCHES, '^on$'],
    [OperatorType.NOT_MATCHES, '^off$'],
  ] as const)('supports the dependent string operator %s', (operator, value) => {
    const condition =
      typeof value === 'string'
        ? flagCondition('prerequisite', operator as OperatorType.MATCHES | OperatorType.NOT_MATCHES, value)
        : flagCondition('prerequisite', operator as OperatorType.ONE_OF | OperatorType.NOT_ONE_OF, value)
    const config = configuration({
      prerequisite: booleanFlag('prerequisite', 'on'),
      dependent: dependentBooleanFlag('dependent', [condition]),
    })

    expect(evaluate(config, 'dependent', logger)).toMatchObject({ value: true, variant: 'on' })
  })

  it('can target a completed prerequisite reason', () => {
    const config = configuration({
      prerequisite: booleanFlag('prerequisite', 'on'),
      dependent: dependentBooleanFlag('dependent', [
        flagCondition('prerequisite', OperatorType.ONE_OF, ['STATIC'], 'reason'),
      ]),
    })

    expect(evaluate(config, 'dependent', logger)).toMatchObject({ value: true, variant: 'on' })
  })

  it('compares a completed error code with ordinary string semantics', () => {
    expect(
      matchesRule(
        { conditions: [flagCondition('prerequisite', OperatorType.MATCHES, '^TYPE_', 'error_code')] },
        {},
        () => 'TYPE_MISMATCH'
      )
    ).toBe(true)
  })

  it('retains successful dependency evaluations while rolling back exposures when a later sibling is missing', () => {
    const config = configuration({
      present: booleanFlag('present', 'on'),
      root: dependentBooleanFlag('root', [
        flagCondition('present', OperatorType.ONE_OF, ['on']),
        flagCondition('missing', OperatorType.ONE_OF, ['on']),
      ]),
    })
    const dependencies: DependencyEvaluation[] = []
    const onExposures = jest.fn()

    expect(
      evaluate(config, 'root', logger, (evaluation) => dependencies.push(evaluation), {}, onExposures)
    ).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
    })
    expect(dependencies).toEqual([
      expect.objectContaining({ flagKey: 'present', details: expect.objectContaining({ value: true, variant: 'on' }) }),
    ])
    expect(onExposures).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith('evaluated a flag', expect.objectContaining({ flagKey: 'present' }))
    expect(logger.warn).toHaveBeenCalledWith('prerequisite flag is missing', { flagKey: 'missing' })
  })

  it('records propagated errors for every dependency ancestor', () => {
    const config = configuration({
      root: dependentBooleanFlag('root', [flagCondition('parent', OperatorType.ONE_OF, ['on'])]),
      parent: dependentBooleanFlag('parent', [flagCondition('child', OperatorType.ONE_OF, ['on'])]),
      child: dependentBooleanFlag('child', [flagCondition('missing', OperatorType.ONE_OF, ['on'])]),
    })
    const dependencies: DependencyEvaluation[] = []

    expect(evaluate(config, 'root', logger, (evaluation) => dependencies.push(evaluation))).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
    })
    expect(dependencies).toMatchObject([
      {
        flagKey: 'child',
        details: { value: false, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' },
      },
      {
        flagKey: 'parent',
        details: { value: false, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' },
      },
    ])
  })

  it('short-circuits before an unneeded missing prerequisite', () => {
    const config = configuration({
      root: dependentBooleanFlag('root', [
        { attribute: 'country', operator: OperatorType.ONE_OF, value: ['US'] },
        flagCondition('missing', OperatorType.ONE_OF, ['on']),
      ]),
    })

    expect(evaluate(config, 'root', logger, jest.fn(), { country: 'CA' })).toMatchObject({
      value: false,
      variant: 'off',
    })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('memoizes a prerequisite once per root evaluation', () => {
    const config = configuration({
      prerequisite: booleanFlag('prerequisite', 'on'),
      root: dependentBooleanFlag('root', [
        flagCondition('prerequisite', OperatorType.ONE_OF, ['on']),
        flagCondition('prerequisite', OperatorType.NOT_ONE_OF, ['off']),
      ]),
    })
    const dependencies: DependencyEvaluation[] = []

    expect(evaluate(config, 'root', logger, (evaluation) => dependencies.push(evaluation)).value).toBe(true)
    expect(dependencies.map(({ flagKey }) => flagKey)).toEqual(['prerequisite'])
  })

  it('propagates a cycle error, retains evaluations, and discards exposures', () => {
    const config = configuration({
      present: booleanFlag('present', 'on'),
      root: dependentBooleanFlag('root', [
        flagCondition('present', OperatorType.ONE_OF, ['on']),
        flagCondition('child', OperatorType.ONE_OF, ['on']),
      ]),
      child: dependentBooleanFlag('child', [flagCondition('root', OperatorType.ONE_OF, ['on'])]),
    })
    const dependencies: DependencyEvaluation[] = []
    const onExposures = jest.fn()

    expect(
      evaluate(config, 'root', logger, (evaluation) => dependencies.push(evaluation), {}, onExposures)
    ).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
    })
    expect(dependencies).toEqual([
      expect.objectContaining({ flagKey: 'present' }),
      expect.objectContaining({
        flagKey: 'child',
        details: expect.objectContaining({ reason: 'ERROR', errorCode: 'GENERAL' }),
      }),
    ])
    expect(onExposures).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('flag dependency cycle detected', { flagKey: 'root' })
  })

  it('treats the root as depth zero and accepts a zero maximum', () => {
    expect(evaluate(configuration({ root: booleanFlag('root', 'on') }, 0), 'root', logger)).toMatchObject({
      value: true,
      variant: 'on',
    })

    const withDependency = configuration(
      {
        root: dependentBooleanFlag('root', [flagCondition('leaf', OperatorType.ONE_OF, ['on'])]),
        leaf: booleanFlag('leaf', 'on'),
      },
      0
    )
    expect(evaluate(withDependency, 'root', logger)).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
    })
  })

  it('uses the hard-coded maximum when the override is omitted', () => {
    const flags: Record<string, Flag> = { leaf: booleanFlag('leaf', 'on') }
    for (let depth = 9; depth >= 0; depth -= 1) {
      const key = depth === 0 ? 'root' : `depth-${depth}`
      const child = depth === 9 ? 'leaf' : `depth-${depth + 1}`
      flags[key] = dependentBooleanFlag(key, [flagCondition(child, OperatorType.ONE_OF, ['on'])])
    }

    expect(evaluate(configuration(flags), 'root', logger)).toMatchObject({ value: true, variant: 'on' })
  })

  it('rejects a maximum that cannot be represented safely in JSON', () => {
    expect(
      evaluate(configuration({ root: booleanFlag('root', 'on') }, Number.MAX_SAFE_INTEGER + 1), 'root', logger)
    ).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'PARSE_ERROR' })
  })

  it('does not enter dependency handling for an ordinary rule', () => {
    const config = configuration({
      root: dependentBooleanFlag('root', [{ attribute: 'country', operator: OperatorType.ONE_OF, value: ['US'] }]),
    })
    const onDependency = jest.fn()
    const onExposures = jest.fn()

    expect(evaluate(config, 'root', logger, onDependency, { country: 'US' }, onExposures)).toMatchObject({
      value: true,
      variant: 'on',
    })
    expect(onDependency).not.toHaveBeenCalled()
    expect(onExposures).not.toHaveBeenCalled()
  })

  it('isolates dependency telemetry sink failures from evaluation', () => {
    const config = configuration({
      prerequisite: booleanFlag('prerequisite', 'on'),
      root: dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])]),
    })

    expect(
      evaluate(config, 'root', logger, () => {
        throw new Error('telemetry unavailable')
      })
    ).toMatchObject({ value: true, variant: 'on' })
  })

  it('does not commit dependency exposures when the root result is an error', () => {
    const config = configuration({
      prerequisite: booleanFlag('prerequisite', 'on'),
      root: dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])]),
    })
    config.flags.root.allocations[0].splits[0].shards = [
      { salt: 'root', totalShards: 1, ranges: [{ start: 0, end: 1 }] },
    ]
    const dependencies: DependencyEvaluation[] = []
    const onExposures = jest.fn()

    expect(
      evaluateRulesBasedConfiguration(
        config,
        'boolean',
        'root',
        false,
        {},
        logger,
        (evaluation) => dependencies.push(evaluation),
        onExposures
      )
    ).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'TARGETING_KEY_MISSING' })
    expect(dependencies.map(({ flagKey }) => flagKey)).toEqual(['prerequisite'])
    expect(onExposures).not.toHaveBeenCalled()
  })
})

function evaluate(
  config: UniversalFlagConfigurationV1,
  flagKey: string,
  logger: Logger,
  onDependency?: (evaluation: DependencyEvaluation) => void,
  attributes: Record<string, unknown> = {},
  onExposures?: (evaluations: readonly DependencyEvaluation[]) => void
) {
  return evaluateRulesBasedConfiguration(
    config,
    'boolean',
    flagKey,
    false,
    { targetingKey: 'subject', ...attributes },
    logger,
    onDependency,
    onExposures
  )
}

function configuration(flags: Record<string, Flag>, maxDependencyDepth?: number): UniversalFlagConfigurationV1 {
  return {
    createdAt: '2026-10-07T12:00:00Z',
    format: 'SERVER',
    ...(maxDependencyDepth === undefined ? {} : { evaluatorParams: { maxDependencyDepth } }),
    environment: { name: 'test' },
    flags,
  }
}

function booleanFlag(key: string, variant: 'on' | 'off'): Flag {
  return {
    key,
    enabled: true,
    variationType: 'BOOLEAN',
    variations: { on: { key: 'on', value: true }, off: { key: 'off', value: false } },
    allocations: [{ key: 'default', doLog: true, rules: [], splits: [{ variationKey: variant, shards: [] }] }],
  }
}

function dependentBooleanFlag(
  key: string,
  conditions: NonNullable<Flag['allocations'][number]['rules']>[number]['conditions']
): Flag {
  return {
    key,
    enabled: true,
    variationType: 'BOOLEAN',
    variations: { on: { key: 'on', value: true }, off: { key: 'off', value: false } },
    allocations: [
      {
        key: 'targeted',
        doLog: true,
        rules: [{ conditions }],
        splits: [{ variationKey: 'on', shards: [] }],
      },
      { key: 'default', doLog: true, rules: [], splits: [{ variationKey: 'off', shards: [] }] },
    ],
  }
}

function flagCondition(
  key: string,
  operator: OperatorType.ONE_OF | OperatorType.NOT_ONE_OF,
  value: readonly string[],
  property?: 'variant_key' | 'reason' | 'error_code'
): {
  flagEvaluation: { key: string; property?: 'variant_key' | 'reason' | 'error_code' }
  operator: OperatorType.ONE_OF | OperatorType.NOT_ONE_OF
  value: string[]
}
function flagCondition(
  key: string,
  operator: OperatorType.MATCHES | OperatorType.NOT_MATCHES,
  value: string,
  property?: 'variant_key' | 'reason' | 'error_code'
): {
  flagEvaluation: { key: string; property?: 'variant_key' | 'reason' | 'error_code' }
  operator: OperatorType.MATCHES | OperatorType.NOT_MATCHES
  value: string
}
function flagCondition(
  key: string,
  operator: OperatorType.ONE_OF | OperatorType.NOT_ONE_OF | OperatorType.MATCHES | OperatorType.NOT_MATCHES,
  value: readonly string[] | string,
  property?: 'variant_key' | 'reason' | 'error_code'
) {
  return {
    flagEvaluation: { key, ...(property === undefined ? {} : { property }) },
    operator,
    value: Array.isArray(value) ? [...value] : value,
  }
}
