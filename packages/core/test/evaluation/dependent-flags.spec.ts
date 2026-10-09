import { create } from '@bufbuild/protobuf'
import type { Logger } from '@openfeature/core'
import {
  ConditionSchema,
  EvaluatorParamsSchema,
  FlagsConfigurationSchema,
  Reason,
  VariationType,
} from '../../src/configuration/generated/ufc_pb'
import { decodeFlagsConfiguration, encodeFlagsConfiguration } from '../../src/configuration/ufc-protobuf'
import {
  type DependencyEvaluation,
  evaluateRulesBasedConfiguration,
  type Flag,
  type UniversalFlagConfigurationV1,
} from '../../src/evaluation'
import { OperatorType } from '../../src/evaluation/rules'

describe('dependent flag evaluation', () => {
  let logger: Logger

  beforeEach(() => {
    logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
  })

  it('evaluates varying depths with one timestamp', () => {
    const config = configuration({
      root: dependentBooleanFlag('root', [flagCondition('middle', OperatorType.ONE_OF, ['on'])]),
      middle: dependentBooleanFlag('middle', [flagCondition('leaf', OperatorType.ONE_OF, ['on'])]),
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

  it('uses the shared dependency session for protobuf UFC', () => {
    const config = protobufDependentConfiguration(true)
    const dependencies: DependencyEvaluation[] = []
    const onExposures = jest.fn()

    expect(
      evaluateRulesBasedConfiguration(
        config,
        'boolean',
        'root',
        false,
        { targetingKey: 'subject' },
        logger,
        (evaluation) => dependencies.push(evaluation),
        onExposures
      )
    ).toMatchObject({ value: true, variant: 'on' })
    expect(dependencies).toMatchObject([{ flagKey: 'prerequisite', details: { value: true, variant: 'on' } }])
    expect(onExposures).toHaveBeenCalledWith([
      expect.objectContaining({ flagKey: 'prerequisite', details: expect.objectContaining({ variant: 'on' }) }),
    ])
  })

  it('fails a protobuf graph when a reached prerequisite returns no variant', () => {
    const config = protobufDependentConfiguration(false)
    const dependencies: DependencyEvaluation[] = []
    const onExposures = jest.fn()

    expect(
      evaluateRulesBasedConfiguration(
        config,
        'boolean',
        'root',
        false,
        { targetingKey: 'subject' },
        logger,
        (evaluation) => dependencies.push(evaluation),
        onExposures
      )
    ).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: 'prerequisite flag evaluation returned no variant',
    })
    expect(dependencies).toMatchObject([
      {
        flagKey: 'prerequisite',
        details: { reason: 'ERROR', errorCode: 'GENERAL' },
      },
    ])
    expect(onExposures).not.toHaveBeenCalled()
  })

  it('supports protobuf NOT_ONE_OF dependencies', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('off')
    const membership = config.conditions[0].kind
    if (membership.case !== 'flagEvaluationStringMembership') throw new Error('unexpected test condition')
    membership.value.stringIndexes = [2]
    membership.value.negate = true

    expect(evaluateProtobuf(roundTrip(config), logger).result).toMatchObject({ value: true, variant: 'on' })
  })

  it('applies the protobuf maximum dependency depth override', () => {
    const config = protobufDependentConfiguration(true)
    config.evaluatorParams = create(EvaluatorParamsSchema, { maxDependencyDepth: BigInt(0) })

    expect(evaluateProtobuf(roundTrip(config), logger).result).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: 'maximum flag dependency depth exceeded',
    })
  })

  it('reports an unsupported protobuf prerequisite variation type as a dependency parse error', () => {
    const config = protobufDependentConfiguration(true)
    config.flags.prerequisite.variationType = 6 as VariationType

    const { result, dependencies, onExposures } = evaluateProtobuf(roundTrip(config), logger)

    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'PARSE_ERROR' })
    expect(dependencies).toMatchObject([
      { flagKey: 'prerequisite', details: { reason: 'ERROR', errorCode: 'PARSE_ERROR' } },
    ])
    expect(onExposures).not.toHaveBeenCalled()
  })

  it('propagates a nested missing protobuf dependency and records its ancestor', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('missing')
    config.conditions.push(
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 2, stringIndexes: [0], negate: false },
        },
      })
    )
    config.flags.prerequisite.allocations[0].targetingConditionIndex = 1

    const { result, dependencies, onExposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' })
    expect(dependencies).toMatchObject([
      { flagKey: 'prerequisite', details: { reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' } },
    ])
    expect(onExposures).not.toHaveBeenCalled()
  })

  it('detects a protobuf dependency cycle', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('root')
    config.conditions.push(
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 2, stringIndexes: [0], negate: false },
        },
      })
    )
    config.flags.prerequisite.allocations[0].targetingConditionIndex = 1

    const { result, dependencies, onExposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: 'flag dependency cycle detected',
    })
    expect(dependencies).toMatchObject([
      { flagKey: 'prerequisite', details: { reason: 'ERROR', errorCode: 'GENERAL' } },
    ])
    expect(onExposures).not.toHaveBeenCalled()
  })

  it('memoizes protobuf dependencies and rolls back exposures after a later missing sibling', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('missing')
    config.conditions.push(
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 1, stringIndexes: [0], negate: false },
        },
      }),
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 2, stringIndexes: [0], negate: false },
        },
      }),
      create(ConditionSchema, {
        kind: { case: 'all', value: { conditionIndexes: [0, 1, 2] } },
      })
    )
    config.flags.root.allocations[0].targetingConditionIndex = 3

    const { result, dependencies, onExposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' })
    expect(dependencies.map(({ flagKey }) => flagKey)).toEqual(['prerequisite'])
    expect(onExposures).not.toHaveBeenCalled()
  })

  it('encodes protobuf dependencies as condition-native values, not partition attributes', () => {
    const config = roundTrip(protobufDependentConfiguration(true))

    expect(config.attributes).toEqual([])
    expect(config.conditions[0].kind).toEqual({
      case: 'flagEvaluationStringMembership',
      value: expect.objectContaining({ flagKeyStringIndex: 1, stringIndexes: [0], negate: false }),
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

  it.each([
    ['first', ['a', 'b']],
    ['last', ['b', 'a']],
  ])('enforces maximum depth when a deeper memoized subtree is reused %s', (_name, rootDependencies) => {
    const config = configuration(
      {
        leaf: booleanFlag('leaf', 'on'),
        a: dependentBooleanFlag('a', [flagCondition('leaf', OperatorType.ONE_OF, ['on'])]),
        b: dependentBooleanFlag('b', [flagCondition('a', OperatorType.ONE_OF, ['on'])]),
        root: dependentBooleanFlag(
          'root',
          rootDependencies.map((key) => flagCondition(key, OperatorType.ONE_OF, ['on']))
        ),
      },
      2
    )
    const onExposures = jest.fn()

    expect(evaluate(config, 'root', logger, undefined, {}, onExposures)).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: 'maximum flag dependency depth exceeded',
    })
    expect(onExposures).not.toHaveBeenCalled()
  })

  it.each([
    ['null', null],
    [
      'missing variationType',
      {
        key: 'prerequisite',
        enabled: true,
        variations: { on: { key: 'on', value: true } },
        allocations: [],
      },
    ],
    [
      'unsupported variationType',
      {
        ...booleanFlag('prerequisite', 'on'),
        variationType: 'FUTURE',
      },
    ],
  ])('reports a present JSON prerequisite with %s as a dependency parse error', (_name, prerequisite) => {
    const config = configuration({
      prerequisite: prerequisite as Flag,
      root: dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])]),
    })
    const dependencies: DependencyEvaluation[] = []
    const onExposures = jest.fn()

    const result = evaluate(config, 'root', logger, (dependency) => dependencies.push(dependency), {}, onExposures)

    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'PARSE_ERROR' })
    expect(dependencies).toMatchObject([
      { flagKey: 'prerequisite', details: { reason: 'ERROR', errorCode: 'PARSE_ERROR' } },
    ])
    expect(onExposures).not.toHaveBeenCalled()
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

  it('emits dependency evaluations before parent and sibling evaluation continues', () => {
    const events: string[] = []
    const timingLogger: Logger = {
      ...logger,
      debug: (message, details) => {
        if (message === 'evaluated a flag') {
          events.push(`evaluated:${String((details as { flagKey?: unknown } | undefined)?.flagKey)}`)
        }
      },
    }
    const config = configuration({
      leaf: booleanFlag('leaf', 'on'),
      parent: dependentBooleanFlag('parent', [flagCondition('leaf', OperatorType.ONE_OF, ['on'])]),
      sibling: booleanFlag('sibling', 'on'),
      root: dependentBooleanFlag('root', [
        flagCondition('parent', OperatorType.ONE_OF, ['on']),
        flagCondition('sibling', OperatorType.ONE_OF, ['on']),
      ]),
    })

    expect(evaluate(config, 'root', timingLogger, ({ flagKey }) => events.push(`telemetry:${flagKey}`))).toMatchObject({
      value: true,
      variant: 'on',
    })
    expect(events).toEqual([
      'evaluated:leaf',
      'telemetry:leaf',
      'evaluated:parent',
      'telemetry:parent',
      'evaluated:sibling',
      'telemetry:sibling',
      'evaluated:root',
    ])
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
  value: readonly string[]
): {
  flagEvaluation: { key: string }
  operator: OperatorType.ONE_OF | OperatorType.NOT_ONE_OF
  value: string[]
}
function flagCondition(key: string, operator: OperatorType.ONE_OF | OperatorType.NOT_ONE_OF, value: readonly string[]) {
  return {
    flagEvaluation: { key },
    operator,
    value: [...value],
  }
}

function protobufDependentConfiguration(prerequisiteHasAllocation: boolean) {
  const variation = {
    keyStringIndex: 0,
    value: { case: 'booleanValue' as const, value: true },
  }
  const split = {
    ranges: [],
    variationIndex: 0,
    serialId: 1,
    reason: Reason.STATIC,
  }
  const prerequisiteAllocation = {
    key: 'prerequisite-static',
    partitionKey: [],
    splits: [split],
    logExposureEvent: true,
  }
  const rootAllocation = {
    key: 'root-targeted',
    targetingConditionIndex: 0,
    partitionKey: [],
    splits: [{ ...split, reason: Reason.TARGETING_MATCH }],
    logExposureEvent: true,
  }

  const configuration = create(FlagsConfigurationSchema, {
    environmentName: 'test',
    strings: ['on', 'prerequisite'],
    conditions: [
      {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 1, stringIndexes: [0], negate: false },
        },
      },
    ],
    flags: {
      root: {
        variationType: VariationType.BOOLEAN,
        variations: [variation],
        allocations: [rootAllocation],
      },
      prerequisite: {
        variationType: VariationType.BOOLEAN,
        variations: [variation],
        allocations: prerequisiteHasAllocation ? [prerequisiteAllocation] : [],
      },
    },
  })
  return decodeFlagsConfiguration(encodeFlagsConfiguration(configuration))
}

function roundTrip(configuration: Parameters<typeof encodeFlagsConfiguration>[0]) {
  return decodeFlagsConfiguration(encodeFlagsConfiguration(configuration))
}

function evaluateProtobuf(configuration: ReturnType<typeof decodeFlagsConfiguration>, logger: Logger) {
  const dependencies: DependencyEvaluation[] = []
  const onExposures = jest.fn()
  const result = evaluateRulesBasedConfiguration(
    configuration,
    'boolean',
    'root',
    false,
    { targetingKey: 'subject' },
    logger,
    (evaluation) => dependencies.push(evaluation),
    onExposures
  )
  return { result, dependencies, onExposures }
}
