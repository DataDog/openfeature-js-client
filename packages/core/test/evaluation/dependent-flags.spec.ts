import { create } from '@bufbuild/protobuf'
import type { Logger } from '@openfeature/core'
import {
  AllocationSchema,
  ConditionSchema,
  EvaluatorParamsSchema,
  FlagsConfigurationSchema,
  Reason,
  SplitSchema,
  VariationType,
} from '../../src/configuration/generated/ufc_pb'
import { prepareRulesResponse } from '../../src/configuration/prepared-rules-response'
import { decodeFlagsConfiguration, encodeFlagsConfiguration } from '../../src/configuration/ufc-protobuf'
import {
  type DependencyEvaluation,
  evaluateRulesBasedConfiguration,
  evaluateRulesBasedConfigurationWithTrace,
  type Flag,
  type UniversalFlagConfigurationV1,
} from '../../src/evaluation'
import { evaluateProtobufConfiguration } from '../../src/evaluation/evaluateProtobufConfiguration'
import { OperatorType } from '../../src/evaluation/rules'
import { timeStampNow } from '../../src/time'

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

  it('ignores future fields in a JSON flag-evaluation reference', () => {
    const condition = flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])
    Object.assign(condition.flagEvaluation, { property: 'variant', futureOption: { enabled: true } })
    const config = configuration({
      prerequisite: booleanFlag('prerequisite', 'on'),
      root: dependentBooleanFlag('root', [condition]),
    })

    expect(evaluate(config, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
  })

  it('reports a missing JSON prerequisite on its event and GENERAL on the root', () => {
    const config = configuration({
      root: dependentBooleanFlag('root', [flagCondition('missing', OperatorType.ONE_OF, ['on'])]),
    })

    const trace = evaluateRulesBasedConfigurationWithTrace(
      config,
      'boolean',
      'root',
      false,
      { targetingKey: 'subject' },
      logger
    )

    expect(trace.details).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: 'prerequisite flag "missing" failed: prerequisite flag is missing',
    })
    expect(trace.dependencyEvaluations).toMatchObject([
      {
        flagKey: 'missing',
        details: {
          reason: 'ERROR',
          errorCode: 'FLAG_NOT_FOUND',
          errorMessage: 'prerequisite flag is missing',
        },
      },
    ])
    expect(trace.dependencyExposures).toEqual([])
  })

  it('does not read a memoized prerequisite configuration again', () => {
    const prerequisite = booleanFlag('prerequisite', 'on')
    const config = configuration({
      root: dependentBooleanFlag('root', [
        flagCondition('prerequisite', OperatorType.ONE_OF, ['on']),
        flagCondition('prerequisite', OperatorType.ONE_OF, ['on']),
      ]),
    })
    let reads = 0
    Object.defineProperty(config.flags, 'prerequisite', {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1
        return prerequisite
      },
    })

    expect(evaluate(config, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
    expect(reads).toBe(2)
  })

  it('applies experimentation opt-out to dependency evaluations', () => {
    const prerequisite = booleanFlag('prerequisite', 'on')
    const root = dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])])
    root.allocations[0].doLog = false
    const trace = evaluateRulesBasedConfigurationWithTrace(
      configuration({ prerequisite, root }),
      'boolean',
      'root',
      false,
      { targetingKey: 'subject', dd_experimentation_opt_out_at: '2026-10-23T00:00:00Z' },
      logger,
      'immediate'
    )

    expect(trace.details).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: 'prerequisite flag "prerequisite" failed: prerequisite flag evaluation returned no variant',
    })
    expect(trace.dependencyEvaluations).toMatchObject([
      { flagKey: 'prerequisite', details: { value: false, reason: 'ERROR', errorCode: 'GENERAL' } },
    ])
  })

  it('uses the shared dependency session for protobuf UFC', () => {
    const config = protobufDependentConfiguration(true)
    const trace = evaluateRulesBasedConfigurationWithTrace(
      config,
      'boolean',
      'root',
      false,
      { targetingKey: 'subject' },
      logger
    )
    expect(trace.details).toMatchObject({ value: true, variant: 'on' })
    expect(trace.dependencyEvaluations).toMatchObject([
      { flagKey: 'prerequisite', details: { value: true, variant: 'on' } },
    ])
    expect(trace.dependencyExposures).toEqual([
      expect.objectContaining({ flagKey: 'prerequisite', details: expect.objectContaining({ variant: 'on' }) }),
    ])
  })

  it('returns equivalent JSON and protobuf dependency evaluation batches', () => {
    const jsonTrace = evaluateRulesBasedConfigurationWithTrace(
      configuration({
        root: dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])]),
        prerequisite: booleanFlag('prerequisite', 'on'),
      }),
      'boolean',
      'root',
      false,
      { targetingKey: 'subject' },
      logger
    )
    const protobufTrace = evaluateRulesBasedConfigurationWithTrace(
      protobufDependentConfiguration(true),
      'boolean',
      'root',
      false,
      { targetingKey: 'subject' },
      logger
    )

    const comparable = (trace: typeof jsonTrace) =>
      trace.dependencyEvaluations.map(({ flagKey, details }) => ({
        flagKey,
        value: details.value,
        variant: details.variant,
        reason: details.reason,
        errorCode: details.errorCode,
      }))
    expect(comparable(jsonTrace)).toEqual(comparable(protobufTrace))
  })

  it('returns a memoized prerequisite once per root evaluation', () => {
    const trace = evaluateRulesBasedConfigurationWithTrace(
      configuration({
        root: dependentBooleanFlag('root', [
          flagCondition('prerequisite', OperatorType.ONE_OF, ['on']),
          flagCondition('prerequisite', OperatorType.ONE_OF, ['on']),
        ]),
        prerequisite: booleanFlag('prerequisite', 'on'),
      }),
      'boolean',
      'root',
      false,
      { targetingKey: 'subject' },
      logger
    )

    expect(trace.details).toMatchObject({ value: true, variant: 'on' })
    expect(trace.dependencyEvaluations.map(({ flagKey }) => flagKey)).toEqual(['prerequisite'])
  })

  it('preserves the completed dependency batch when root evaluation throws', () => {
    const throwingLogger: Logger = {
      ...logger,
      debug: (message, details) => {
        if (message === 'evaluated a flag' && (details as { flagKey?: unknown } | undefined)?.flagKey === 'root') {
          throw new Error('root reporting failed')
        }
      },
    }
    const trace = evaluateRulesBasedConfigurationWithTrace(
      configuration({
        root: dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])]),
        prerequisite: booleanFlag('prerequisite', 'on'),
      }),
      'boolean',
      'root',
      false,
      { targetingKey: 'subject' },
      throwingLogger
    )

    expect(trace.details).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'GENERAL' })
    expect(trace.dependencyEvaluations.map(({ flagKey }) => flagKey)).toEqual(['prerequisite'])
    expect(trace.dependencyExposures).toEqual([])
  })

  it('fails a protobuf graph when a reached prerequisite returns no variant', () => {
    const config = protobufDependentConfiguration(false)
    const trace = evaluateRulesBasedConfigurationWithTrace(
      config,
      'boolean',
      'root',
      false,
      { targetingKey: 'subject' },
      logger
    )
    expect(trace.details).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: 'prerequisite flag "prerequisite" failed: prerequisite flag evaluation returned no variant',
    })
    expect(trace.dependencyEvaluations).toMatchObject([
      {
        flagKey: 'prerequisite',
        details: { reason: 'ERROR', errorCode: 'GENERAL' },
      },
    ])
    expect(trace.dependencyExposures).toEqual([])
  })

  it('supports protobuf NOT_ONE_OF dependencies', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('off')
    const membership = config.conditions[0].kind
    if (membership.case !== 'flagEvaluationStringMembership') throw new Error('unexpected test condition')
    membership.value.variantKeyStringIndexes = [2]
    membership.value.negate = true

    expect(evaluateProtobuf(roundTrip(config), logger).result).toMatchObject({ value: true, variant: 'on' })
  })

  it('discards a JSON rule exposure buffer when its prerequisite variant does not match', () => {
    const prerequisite = booleanFlag('prerequisite', 'on')
    const root = dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['off'])])
    const dependencies: DependencyEvaluation[] = []
    const onExposures = jest.fn()

    expect(
      evaluate(
        configuration({ prerequisite, root }),
        'root',
        logger,
        (dependency) => dependencies.push(dependency),
        {},
        onExposures
      )
    ).toMatchObject({ value: false, variant: 'off', flagMetadata: { __dd_allocation_key: 'default' } })
    expect(dependencies).toMatchObject([{ flagKey: 'prerequisite', details: { variant: 'on' } }])
    expect(onExposures).toHaveBeenCalledWith([])
  })

  it('discards JSON dependency exposures when a matching allocation has no selected split', () => {
    const prerequisite = booleanFlag('prerequisite', 'on')
    const root = dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])])
    root.allocations[0].splits[0].shards = [{ salt: 'empty', totalShards: 1, ranges: [{ start: 0, end: 0 }] }]
    const dependencies: DependencyEvaluation[] = []
    const onExposures = jest.fn()

    expect(
      evaluate(
        configuration({ prerequisite, root }),
        'root',
        logger,
        (dependency) => dependencies.push(dependency),
        {},
        onExposures
      )
    ).toMatchObject({ value: false, variant: 'off', flagMetadata: { __dd_allocation_key: 'default' } })
    expect(dependencies).toMatchObject([{ flagKey: 'prerequisite', details: { variant: 'on' } }])
    expect(onExposures).toHaveBeenCalledWith([])
  })

  it('discards a protobuf allocation exposure buffer when its prerequisite variant does not match', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('off')
    const membership = config.conditions[0].kind
    if (membership.case !== 'flagEvaluationStringMembership') throw new Error('unexpected test condition')
    membership.value.variantKeyStringIndexes = [2]
    config.flags.root.allocations.push(
      create(AllocationSchema, {
        key: 'root-fallback',
        partitionKey: [],
        splits: [create(SplitSchema, { ranges: [], variationIndex: 0, serialId: 2, reason: Reason.STATIC })],
        logExposureEvent: true,
      })
    )

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({ value: true, variant: 'on', flagMetadata: { __dd_allocation_key: 'root-fallback' } })
    expect(dependencies).toMatchObject([{ flagKey: 'prerequisite', details: { variant: 'on' } }])
    expect(exposures).toEqual([])
  })

  it('discards provenance from a failed protobuf ANY branch when a later branch is selected', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('off')
    const membership = config.conditions[0].kind
    if (membership.case !== 'flagEvaluationStringMembership') throw new Error('unexpected test condition')
    membership.value.variantKeyStringIndexes = [2]
    config.conditions.push(
      create(ConditionSchema, { kind: { case: 'all', value: { conditionIndexes: [] } } }),
      create(ConditionSchema, { kind: { case: 'any', value: { conditionIndexes: [0, 1] } } })
    )
    config.flags.root.allocations[0].targetingConditionIndex = 2

    const { result, exposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({ value: true, variant: 'on', flagMetadata: { __dd_allocation_key: 'root-targeted' } })
    expect(exposures).toEqual([])
  })

  it('discards a matched dependency exposure when a later condition rejects its protobuf targeting rule', () => {
    const config = protobufDependentConfiguration(true)
    config.conditions.push(
      create(ConditionSchema, { kind: { case: 'any', value: { conditionIndexes: [] } } }),
      create(ConditionSchema, { kind: { case: 'all', value: { conditionIndexes: [0, 1] } } }),
      create(ConditionSchema, { kind: { case: 'all', value: { conditionIndexes: [] } } }),
      create(ConditionSchema, { kind: { case: 'any', value: { conditionIndexes: [2, 3] } } })
    )
    config.flags.root.allocations[0].targetingConditionIndex = 4

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({ value: true, variant: 'on', flagMetadata: { __dd_allocation_key: 'root-targeted' } })
    expect(dependencies).toMatchObject([{ flagKey: 'prerequisite', details: { variant: 'on' } }])
    expect(exposures).toEqual([])
  })

  it('discards protobuf provenance when a matching allocation produces no assignment', () => {
    const config = protobufDependentConfiguration(true)
    config.flags.root.allocations[0].splits = []
    config.flags.root.allocations.push(
      create(AllocationSchema, {
        key: 'root-fallback',
        partitionKey: [],
        splits: [create(SplitSchema, { ranges: [], variationIndex: 0, serialId: 2, reason: Reason.STATIC })],
        logExposureEvent: true,
      })
    )

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({ value: true, variant: 'on', flagMetadata: { __dd_allocation_key: 'root-fallback' } })
    expect(dependencies).toMatchObject([{ flagKey: 'prerequisite', details: { variant: 'on' } }])
    expect(exposures).toEqual([])
  })

  it('replays ordered, deduplicated protobuf provenance for a cached multi-dependency condition', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('second-prerequisite')
    config.flags['second-prerequisite'] = { ...config.flags.prerequisite }
    config.conditions.push(
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 2, variantKeyStringIndexes: [0], negate: false },
        },
      }),
      create(ConditionSchema, { kind: { case: 'all', value: { conditionIndexes: [0, 1] } } })
    )
    config.flags.root.allocations[0].targetingConditionIndex = 2
    config.flags.root.allocations[0].splits = []
    config.flags.root.allocations.push(
      create(AllocationSchema, {
        key: 'root-targeted-fallback',
        targetingConditionIndex: 2,
        partitionKey: [],
        splits: [create(SplitSchema, { ranges: [], variationIndex: 0, serialId: 2, reason: Reason.TARGETING_MATCH })],
        logExposureEvent: true,
      })
    )

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({
      value: true,
      variant: 'on',
      flagMetadata: { __dd_allocation_key: 'root-targeted-fallback' },
    })
    expect(dependencies.map(({ flagKey }) => flagKey)).toEqual(['prerequisite', 'second-prerequisite'])
    expect(exposures.map(({ flagKey }) => flagKey)).toEqual(['prerequisite', 'second-prerequisite'])
  })

  it('does not replay a rolled-back leaf exposure from a cached protobuf parent', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('parent', 'off')
    config.conditions[0] = create(ConditionSchema, {
      kind: {
        case: 'flagEvaluationStringMembership',
        value: { flagKeyStringIndex: 2, variantKeyStringIndexes: [0], negate: false },
      },
    })
    config.conditions.push(
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 1, variantKeyStringIndexes: [3], negate: false },
        },
      })
    )
    config.flags.parent = {
      ...config.flags.prerequisite,
      allocations: [
        create(AllocationSchema, {
          key: 'parent-rejected',
          targetingConditionIndex: 1,
          partitionKey: [],
          splits: [create(SplitSchema, { ranges: [], variationIndex: 0, serialId: 2, reason: Reason.TARGETING_MATCH })],
          logExposureEvent: true,
        }),
        create(AllocationSchema, {
          key: 'parent-default',
          partitionKey: [],
          splits: [create(SplitSchema, { ranges: [], variationIndex: 0, serialId: 3, reason: Reason.STATIC })],
          logExposureEvent: true,
        }),
      ],
    }
    config.flags.root.allocations[0].splits = []
    config.flags.root.allocations.push(
      create(AllocationSchema, {
        key: 'root-targeted-fallback',
        targetingConditionIndex: 0,
        partitionKey: [],
        splits: [create(SplitSchema, { ranges: [], variationIndex: 0, serialId: 4, reason: Reason.TARGETING_MATCH })],
        logExposureEvent: true,
      })
    )

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({
      value: true,
      variant: 'on',
      flagMetadata: { __dd_allocation_key: 'root-targeted-fallback' },
    })
    expect(dependencies.map(({ flagKey }) => flagKey)).toEqual(['prerequisite', 'parent'])
    expect(exposures.map(({ flagKey }) => flagKey)).toEqual(['parent'])
  })

  it('replays the selected protobuf ANY branch witness from a cached condition', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('off')
    config.conditions.push(
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 1, variantKeyStringIndexes: [2], negate: false },
        },
      }),
      create(ConditionSchema, { kind: { case: 'any', value: { conditionIndexes: [1, 0] } } })
    )
    config.flags.root.allocations[0].targetingConditionIndex = 2
    config.flags.root.allocations[0].splits = []
    config.flags.root.allocations.push(
      create(AllocationSchema, {
        key: 'root-targeted-fallback',
        targetingConditionIndex: 2,
        partitionKey: [],
        splits: [create(SplitSchema, { ranges: [], variationIndex: 0, serialId: 2, reason: Reason.TARGETING_MATCH })],
        logExposureEvent: true,
      })
    )

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({
      variant: 'on',
      flagMetadata: { __dd_allocation_key: 'root-targeted-fallback' },
    })
    expect(dependencies.map(({ flagKey }) => flagKey)).toEqual(['prerequisite'])
    expect(exposures.map(({ flagKey }) => flagKey)).toEqual(['prerequisite'])
  })

  it('does not replay a dependency from a cached false protobuf condition', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('off')
    config.conditions.push(
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 1, variantKeyStringIndexes: [2], negate: false },
        },
      }),
      create(ConditionSchema, { kind: { case: 'all', value: { conditionIndexes: [] } } }),
      create(ConditionSchema, { kind: { case: 'any', value: { conditionIndexes: [1, 2] } } })
    )
    config.flags.root.allocations[0].targetingConditionIndex = 1
    config.flags.root.allocations.push(
      create(AllocationSchema, {
        key: 'root-targeted-fallback',
        targetingConditionIndex: 3,
        partitionKey: [],
        splits: [create(SplitSchema, { ranges: [], variationIndex: 0, serialId: 2, reason: Reason.TARGETING_MATCH })],
        logExposureEvent: true,
      })
    )

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({
      variant: 'on',
      flagMetadata: { __dd_allocation_key: 'root-targeted-fallback' },
    })
    expect(dependencies.map(({ flagKey }) => flagKey)).toEqual(['prerequisite'])
    expect(exposures).toEqual([])
  })

  it('does not publish protobuf dependency exposures when the root evaluation fails after a match', () => {
    const config = protobufDependentConfiguration(true)
    config.flags.root.allocations[0].splits[0].variationIndex = 5

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'PARSE_ERROR' })
    expect(dependencies.map(({ flagKey }) => flagKey)).toEqual(['prerequisite'])
    expect(exposures).toEqual([])
  })

  it('applies the protobuf maximum dependency depth override', () => {
    const config = protobufDependentConfiguration(true)
    config.evaluatorParams = create(EvaluatorParamsSchema, { maxDependencyDepth: BigInt(0) })

    expect(evaluateProtobuf(roundTrip(config), logger).result).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: 'prerequisite flag "prerequisite" failed: maximum flag dependency depth exceeded',
    })
  })

  it('allows ten protobuf dependency edges and rejects eleven when the override is omitted', () => {
    expect(evaluateProtobuf(protobufDependencyChain(10), logger).result).toMatchObject({
      value: true,
      variant: 'on',
    })
    expect(evaluateProtobuf(protobufDependencyChain(11), logger).result).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
    })
  })

  it('accepts the protobuf maximum dependency depth override of 255', () => {
    const config = protobufDependentConfiguration(true)
    config.evaluatorParams = create(EvaluatorParamsSchema, { maxDependencyDepth: BigInt(255) })

    expect(evaluateProtobuf(roundTrip(config), logger).result).toMatchObject({ value: true, variant: 'on' })
    expect(logger.warn).not.toHaveBeenCalledWith('Invalid evaluatorParams.maxDependencyDepth; using default', {
      defaultMaxDependencyDepth: 10,
    })
  })

  it('uses the default for an invalid protobuf maximum depth', () => {
    const source = protobufDependentConfiguration(true)
    source.evaluatorParams = create(EvaluatorParamsSchema, { maxDependencyDepth: BigInt(256) })
    const config = roundTrip(source)

    expect(evaluateProtobuf(config, logger).result).toMatchObject({ value: true, variant: 'on' })
    expect(logger.warn).toHaveBeenCalledWith('Invalid evaluatorParams.maxDependencyDepth; using default', {
      defaultMaxDependencyDepth: 10,
    })
  })

  it('uses the default depth for invalid protobuf options before detecting self-reference', () => {
    const config = protobufDependentConfiguration(true)
    config.strings[1] = 'root'
    config.evaluatorParams = create(EvaluatorParamsSchema, { maxDependencyDepth: BigInt(256) })

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)

    expect(result).toMatchObject({ reason: 'ERROR', errorCode: 'GENERAL' })
    expect(dependencies).toEqual([])
    expect(exposures).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith('Invalid evaluatorParams.maxDependencyDepth; using default', {
      defaultMaxDependencyDepth: 10,
    })
  })

  it('accepts the protobuf maximum depth upper boundary', () => {
    const config = protobufDependentConfiguration(true)
    config.evaluatorParams = create(EvaluatorParamsSchema, { maxDependencyDepth: BigInt(255) })

    expect(evaluateProtobuf(config, logger).result).toMatchObject({ value: true, variant: 'on' })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('rejects a JSON number representation in a protobuf configuration', () => {
    const config = protobufDependentConfiguration(true)
    config.evaluatorParams = { maxDependencyDepth: 0 } as never

    expect(evaluateProtobuf(config, logger).result).toMatchObject({ value: true, variant: 'on' })
    expect(logger.warn).toHaveBeenCalledWith('Invalid evaluatorParams.maxDependencyDepth; using default', {
      defaultMaxDependencyDepth: 10,
    })
  })

  it.each([BigInt(-1), BigInt(256), BigInt(2) ** BigInt(64)])(
    'uses the default for an out-of-range protobuf maximum depth %p',
    (maximumDepth) => {
      const config = protobufDependentConfiguration(true)
      config.evaluatorParams = { maxDependencyDepth: maximumDepth } as never

      expect(evaluateProtobuf(config, logger).result).toMatchObject({ value: true, variant: 'on' })
      expect(logger.warn).toHaveBeenCalledWith('Invalid evaluatorParams.maxDependencyDepth; using default', {
        defaultMaxDependencyDepth: 10,
      })
    }
  )
  it('rejects an empty protobuf dependency key as malformed configuration', () => {
    const config = protobufDependentConfiguration(true)
    config.strings[1] = ''

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)

    expect(result).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
      errorMessage: 'Flag evaluation key must not be empty',
    })
    expect(dependencies).toEqual([])
    expect(exposures).toEqual([])
  })

  it('reports an unsupported protobuf prerequisite variation type as a dependency parse error', () => {
    const config = protobufDependentConfiguration(true)
    config.flags.prerequisite.variationType = 6 as VariationType

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)

    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'GENERAL' })
    expect(dependencies).toMatchObject([
      { flagKey: 'prerequisite', details: { reason: 'ERROR', errorCode: 'PARSE_ERROR' } },
    ])
    expect(exposures).toEqual([])
  })

  it('propagates a nested missing protobuf dependency and records its ancestor', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('missing')
    config.conditions.push(
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 2, variantKeyStringIndexes: [0], negate: false },
        },
      })
    )
    config.flags.prerequisite.allocations[0].targetingConditionIndex = 1

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: 'prerequisite flag "missing" failed: prerequisite flag is missing',
    })
    expect(dependencies).toMatchObject([
      {
        flagKey: 'missing',
        details: {
          reason: 'ERROR',
          errorCode: 'FLAG_NOT_FOUND',
          errorMessage: 'prerequisite flag is missing',
        },
      },
      {
        flagKey: 'prerequisite',
        details: {
          reason: 'ERROR',
          errorCode: 'GENERAL',
          errorMessage: 'prerequisite flag "missing" failed: prerequisite flag is missing',
        },
      },
    ])
    expect(exposures).toEqual([])
    expect(logger.debug).toHaveBeenCalledWith('prerequisite flag is missing', { flagKey: 'missing' })
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('detects a protobuf dependency cycle', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('root')
    config.conditions.push(
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 2, variantKeyStringIndexes: [0], negate: false },
        },
      })
    )
    config.flags.prerequisite.allocations[0].targetingConditionIndex = 1

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: 'prerequisite flag "root" failed: flag dependency cycle detected',
    })
    expect(dependencies).toMatchObject([
      { flagKey: 'prerequisite', details: { reason: 'ERROR', errorCode: 'GENERAL' } },
    ])
    expect(exposures).toEqual([])
    expect(logger.debug).toHaveBeenCalledWith('flag dependency cycle detected', { flagKey: 'root' })
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('memoizes protobuf dependencies and rolls back exposures after a later missing sibling', () => {
    const config = protobufDependentConfiguration(true)
    config.strings.push('missing')
    config.conditions.push(
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 1, variantKeyStringIndexes: [0], negate: false },
        },
      }),
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 2, variantKeyStringIndexes: [0], negate: false },
        },
      }),
      create(ConditionSchema, {
        kind: { case: 'all', value: { conditionIndexes: [0, 1, 2] } },
      })
    )
    config.flags.root.allocations[0].targetingConditionIndex = 3

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'GENERAL' })
    expect(dependencies.map(({ flagKey }) => flagKey)).toEqual(['prerequisite', 'missing'])
    expect(exposures).toEqual([])
  })

  it('memoizes shared protobuf condition DAG outcomes', () => {
    const config = protobufDependentConfiguration(true)
    config.conditions = [
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 1, variantKeyStringIndexes: [0], negate: false },
        },
      }),
      create(ConditionSchema, { kind: { case: 'all', value: { conditionIndexes: [0] } } }),
    ]
    for (let index = 2; index < 28; index += 1) {
      config.conditions.push(
        create(ConditionSchema, {
          kind: { case: 'all', value: { conditionIndexes: [index - 2, index - 1] } },
        })
      )
    }
    config.flags.root.allocations[0].targetingConditionIndex = 27
    const resolveFlagEvaluation = jest.fn(() => 'on')

    expect(
      evaluateProtobufConfiguration(
        prepareRulesResponse(config),
        'boolean',
        'root',
        false,
        { targetingKey: 'subject' },
        logger,
        timeStampNow(),
        false,
        resolveFlagEvaluation
      )
    ).toMatchObject({ value: true, variant: 'on' })
    expect(resolveFlagEvaluation).toHaveBeenCalledTimes(1)
  })

  it('retains one exposure witness for a shared protobuf condition DAG', () => {
    const config = protobufDependentConfiguration(true)
    config.conditions = [
      create(ConditionSchema, {
        kind: {
          case: 'flagEvaluationStringMembership',
          value: { flagKeyStringIndex: 1, variantKeyStringIndexes: [0], negate: false },
        },
      }),
      create(ConditionSchema, { kind: { case: 'all', value: { conditionIndexes: [0] } } }),
    ]
    for (let index = 2; index < 28; index += 1) {
      config.conditions.push(
        create(ConditionSchema, {
          kind: { case: 'all', value: { conditionIndexes: [index - 2, index - 1] } },
        })
      )
    }
    config.flags.root.allocations[0].targetingConditionIndex = 27

    const { result, dependencies, exposures } = evaluateProtobuf(roundTrip(config), logger)
    expect(result).toMatchObject({ value: true, variant: 'on' })
    expect(dependencies).toHaveLength(1)
    expect(exposures).toEqual([
      expect.objectContaining({ flagKey: 'prerequisite', details: expect.objectContaining({ variant: 'on' }) }),
    ])
  })

  it('encodes protobuf dependencies as condition-native values, not partition attributes', () => {
    const config = roundTrip(protobufDependentConfiguration(true))

    expect(config.attributes).toEqual([])
    expect(config.conditions[0].kind).toEqual({
      case: 'flagEvaluationStringMembership',
      value: expect.objectContaining({ flagKeyStringIndex: 1, variantKeyStringIndexes: [0], negate: false }),
    })
  })

  it('allows ten dependency edges and rejects eleven when the override is omitted', () => {
    const flags: Record<string, Flag> = { leaf: booleanFlag('leaf', 'on') }
    for (let depth = 9; depth >= 0; depth -= 1) {
      const key = depth === 0 ? 'root' : `depth-${depth}`
      const child = depth === 9 ? 'leaf' : `depth-${depth + 1}`
      flags[key] = dependentBooleanFlag(key, [flagCondition(child, OperatorType.ONE_OF, ['on'])])
    }

    expect(evaluate(configuration(flags), 'root', logger)).toMatchObject({ value: true, variant: 'on' })

    flags['depth-10'] = dependentBooleanFlag('depth-10', [flagCondition('leaf', OperatorType.ONE_OF, ['on'])])
    flags['depth-9'] = dependentBooleanFlag('depth-9', [flagCondition('depth-10', OperatorType.ONE_OF, ['on'])])
    expect(evaluate(configuration(flags), 'root', logger)).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
    })
  })

  it('leaves an extensible evaluator parameters block without a depth override untouched', () => {
    const evaluatorParams = { futureParameter: { enabled: true } }
    const config = configuration({ root: booleanFlag('root', 'on') })
    config.evaluatorParams = evaluatorParams

    expect(evaluate(config, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
    expect(config.evaluatorParams).toBe(evaluatorParams)
    expect(config.evaluatorParams).toEqual({ futureParameter: { enabled: true } })
    expect(logger.warn).not.toHaveBeenCalledWith('Invalid evaluatorParams.maxDependencyDepth; using default', {
      defaultMaxDependencyDepth: 10,
    })
  })

  it('ignores an inherited maximum depth while preserving own future parameters', () => {
    const evaluatorParams = Object.assign(Object.create({ maxDependencyDepth: 0 }), {
      futureParameter: { enabled: true },
    })
    const config = configuration({
      prerequisite: booleanFlag('prerequisite', 'on'),
      root: dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])]),
    })
    config.evaluatorParams = evaluatorParams

    expect(evaluate(config, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
    expect(config.evaluatorParams).toBe(evaluatorParams)
    expect(Object.keys(evaluatorParams)).toEqual(['futureParameter'])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('reads the maximum depth once for each root evaluation without caching it', () => {
    const config = configuration({ root: booleanFlag('root', 'on') })
    let reads = 0
    const evaluatorParams = Object.defineProperty({}, 'maxDependencyDepth', {
      get: () => {
        reads += 1
        return 10
      },
    })
    config.evaluatorParams = evaluatorParams as never

    expect(evaluate(config, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
    expect(reads).toBe(1)
    expect(evaluate(config, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
    expect(reads).toBe(2)
  })

  it.each([0, 255])('accepts JSON maximum depth %p', (maximumDepth) => {
    const config = configuration(
      {
        prerequisite: booleanFlag('prerequisite', 'on'),
        root: dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])]),
      },
      maximumDepth
    )

    const result = evaluate(config, 'root', logger)
    if (maximumDepth === 0) {
      expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'GENERAL' })
    } else {
      expect(result).toMatchObject({ value: true, variant: 'on' })
    }
    expect(logger.warn).not.toHaveBeenCalledWith('Invalid evaluatorParams.maxDependencyDepth; using default', {
      defaultMaxDependencyDepth: 10,
    })
  })

  it('reads the protobuf maximum depth once for each root evaluation without caching it', () => {
    const config = protobufDependentConfiguration(true)
    let reads = 0
    config.evaluatorParams = Object.defineProperty({}, 'maxDependencyDepth', {
      get: () => {
        reads += 1
        return BigInt(10)
      },
    }) as never

    expect(evaluateProtobuf(config, logger).result).toMatchObject({ value: true, variant: 'on' })
    expect(reads).toBe(1)
    expect(evaluateProtobuf(config, logger).result).toMatchObject({ value: true, variant: 'on' })
    expect(reads).toBe(2)
  })

  it('does not cache a malformed-depth warning across root evaluations', () => {
    const config = configuration({ root: booleanFlag('root', 'on') }, 256)

    expect(evaluate(config, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
    expect(evaluate(config, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })

  it('keeps evaluation successful when reading or warning about the maximum depth throws', () => {
    const config = configuration({ root: booleanFlag('root', 'on') })
    config.evaluatorParams = Object.defineProperty({}, 'maxDependencyDepth', {
      get: () => {
        throw new Error('failed to read depth')
      },
    })
    logger.warn = () => {
      throw new Error('failed to warn')
    }

    expect(evaluate(config, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
  })

  it.each([null, [], 'invalid', { maxDependencyDepth: '10' }])(
    'uses the default for a malformed evaluator parameters value %#',
    (evaluatorParams) => {
      const config = configuration({ root: booleanFlag('root', 'on') })
      config.evaluatorParams = evaluatorParams as never

      expect(evaluate(config, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
      expect(logger.warn).toHaveBeenCalledWith('Invalid evaluatorParams.maxDependencyDepth; using default', {
        defaultMaxDependencyDepth: 10,
      })
    }
  )

  it.each([256, -1, 1.5, NaN, Infinity, -Infinity])(
    'uses the default for an invalid JSON maximum depth %p',
    (maximumDepth) => {
      const ordinary = configuration({ root: booleanFlag('root', 'on') }, maximumDepth)
      expect(evaluate(ordinary, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
      expect(logger.warn).toHaveBeenLastCalledWith('Invalid evaluatorParams.maxDependencyDepth; using default', {
        defaultMaxDependencyDepth: 10,
      })
      jest.mocked(logger.warn).mockClear()

      const dependent = configuration(
        {
          prerequisite: booleanFlag('prerequisite', 'on'),
          root: dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])]),
        },
        maximumDepth
      )
      expect(evaluate(dependent, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
      expect(logger.warn).toHaveBeenLastCalledWith('Invalid evaluatorParams.maxDependencyDepth; using default', {
        defaultMaxDependencyDepth: 10,
      })
    }
  )

  it.each([0, 255])('accepts the JSON maximum depth boundary %p', (maximumDepth) => {
    const config = configuration({ root: booleanFlag('root', 'on') }, maximumDepth)

    expect(evaluate(config, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('enforces a JSON maximum dependency depth of zero', () => {
    const config = configuration(
      {
        prerequisite: booleanFlag('prerequisite', 'on'),
        root: dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])]),
      },
      0
    )

    expect(evaluate(config, 'root', logger)).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: 'prerequisite flag "prerequisite" failed: maximum flag dependency depth exceeded',
    })
    expect(logger.warn).not.toHaveBeenCalledWith('Invalid evaluatorParams.maxDependencyDepth; using default', {
      defaultMaxDependencyDepth: 10,
    })
  })

  it('rejects a protobuf bigint representation in a JSON configuration', () => {
    const config = configuration({
      prerequisite: booleanFlag('prerequisite', 'on'),
      root: dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])]),
    })
    config.evaluatorParams = { maxDependencyDepth: BigInt(0) } as never

    expect(evaluate(config, 'root', logger)).toMatchObject({ value: true, variant: 'on' })
    expect(logger.warn).toHaveBeenCalledWith('Invalid evaluatorParams.maxDependencyDepth; using default', {
      defaultMaxDependencyDepth: 10,
    })
  })

  it('uses the default depth for invalid JSON options before detecting self-reference', () => {
    const config = configuration(
      {
        root: dependentBooleanFlag('root', [flagCondition('root', OperatorType.ONE_OF, ['on'])]),
      },
      256
    )

    const trace = evaluateRulesBasedConfigurationWithTrace(
      config,
      'boolean',
      'root',
      false,
      { targetingKey: 'subject' },
      logger
    )

    expect(trace.details).toMatchObject({ reason: 'ERROR', errorCode: 'GENERAL' })
    expect(trace.dependencyEvaluations).toEqual([])
    expect(trace.dependencyExposures).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith('Invalid evaluatorParams.maxDependencyDepth; using default', {
      defaultMaxDependencyDepth: 10,
    })
  })

  it('emits an error evaluation for the prerequisite rejected by the depth limit', () => {
    const config = configuration(
      {
        root: dependentBooleanFlag('root', [flagCondition('a', OperatorType.ONE_OF, ['on'])]),
        a: dependentBooleanFlag('a', [flagCondition('b', OperatorType.ONE_OF, ['on'])]),
        b: dependentBooleanFlag('b', [flagCondition('c', OperatorType.ONE_OF, ['on'])]),
        c: booleanFlag('c', 'on'),
      },
      2
    )
    const dependencies: DependencyEvaluation[] = []

    expect(evaluate(config, 'root', logger, (dependency) => dependencies.push(dependency))).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: 'prerequisite flag "c" failed: maximum flag dependency depth exceeded',
    })
    expect(dependencies).toMatchObject([
      { flagKey: 'c', details: { reason: 'ERROR', errorCode: 'GENERAL' } },
      { flagKey: 'b', details: { reason: 'ERROR', errorCode: 'GENERAL' } },
      { flagKey: 'a', details: { reason: 'ERROR', errorCode: 'GENERAL' } },
    ])
    expect(logger.debug).toHaveBeenCalledWith('maximum flag dependency depth exceeded', {
      flagKey: 'c',
      maxDependencyDepth: 2,
    })
    expect(logger.warn).toHaveBeenCalledTimes(1)
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
    const dependencies: DependencyEvaluation[] = []

    expect(
      evaluate(config, 'root', logger, (dependency) => dependencies.push(dependency), {}, onExposures)
    ).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
      errorMessage: expect.stringMatching(/^prerequisite flag ".+" failed: maximum flag dependency depth exceeded$/),
    })
    expect(dependencies.map(({ flagKey }) => flagKey)).toEqual(['leaf', 'a', 'b'])
    expect(onExposures).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(
      'maximum flag dependency depth exceeded',
      expect.objectContaining({ maxDependencyDepth: 2 })
    )
    expect(logger.warn).toHaveBeenCalledTimes(1)
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

    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'GENERAL' })
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

  it('returns dependency evaluations only after the root evaluation completes', () => {
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
      'evaluated:parent',
      'evaluated:sibling',
      'evaluated:root',
      'telemetry:leaf',
      'telemetry:parent',
      'telemetry:sibling',
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

  it('isolates dependency resolution and exposures from telemetry sink mutation', () => {
    const config = configuration({
      prerequisite: booleanFlag('prerequisite', 'on'),
      root: dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])]),
    })
    const onExposures = jest.fn()

    const result = evaluate(
      config,
      'root',
      logger,
      (dependency) => {
        dependency.flagKey = 'mutated'
        dependency.details.value = false
        delete dependency.details.variant
        delete dependency.details.flagMetadata?.evaluationTimestamp
      },
      {},
      onExposures
    )

    expect(result).toMatchObject({ value: true, variant: 'on' })
    expect(onExposures).toHaveBeenCalledWith([
      expect.objectContaining({
        flagKey: 'prerequisite',
        details: expect.objectContaining({ variant: 'on' }),
      }),
    ])
    expect(onExposures.mock.calls[0]?.[0][0]?.details).not.toHaveProperty('value')
  })

  it('isolates dependency resolution from telemetry snapshot failures', () => {
    const cyclicValue: Record<string, unknown> = {}
    cyclicValue.self = cyclicValue
    cyclicValue.state = 'original'
    const prerequisite: Flag = {
      key: 'prerequisite',
      enabled: true,
      variationType: 'JSON',
      variations: { on: { key: 'on', value: cyclicValue as never } },
      allocations: [{ key: 'default', doLog: true, rules: [], splits: [{ variationKey: 'on', shards: [] }] }],
    }
    const config = configuration({
      prerequisite,
      root: dependentBooleanFlag('root', [flagCondition('prerequisite', OperatorType.ONE_OF, ['on'])]),
    })
    const onDependency = jest.fn()
    const onExposures = jest.fn()

    expect(evaluate(config, 'root', logger, onDependency, {}, onExposures)).toMatchObject({
      value: true,
      variant: 'on',
    })
    expect(onDependency).not.toHaveBeenCalled()
    expect(onExposures).toHaveBeenCalledWith([
      expect.objectContaining({ flagKey: 'prerequisite', details: expect.objectContaining({ variant: 'on' }) }),
    ])
    expect(onExposures.mock.calls[0]?.[0][0]?.details).not.toHaveProperty('value')
    expect(cyclicValue.state).toBe('original')
    expect(
      evaluateRulesBasedConfiguration(config, 'object', 'prerequisite', {}, { targetingKey: 'subject' }, logger).value
    ).toBe(cyclicValue)
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
  const trace = evaluateRulesBasedConfigurationWithTrace(
    config,
    'boolean',
    flagKey,
    false,
    { targetingKey: 'subject', ...attributes },
    logger
  )
  for (const dependency of trace.dependencyEvaluations) {
    try {
      onDependency?.(dependency)
    } catch {
      // Test adapter mirrors the provider's best-effort publication boundary.
    }
  }
  if (trace.details.reason !== 'ERROR' && containsDependency(config.flags[flagKey])) {
    onExposures?.(trace.dependencyExposures)
  }
  return trace.details
}

function containsDependency(flag: Flag | undefined): boolean {
  return (
    flag?.allocations.some((allocation) =>
      allocation.rules?.some((rule) => rule.conditions.some((condition) => 'flagEvaluation' in condition))
    ) === true
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
          value: { flagKeyStringIndex: 1, variantKeyStringIndexes: [0], negate: false },
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

function protobufDependencyChain(edgeCount: number) {
  const dependencyKeys = Array.from({ length: edgeCount }, (_, index) =>
    index === edgeCount - 1 ? 'leaf' : `depth-${index + 1}`
  )
  const variation = {
    keyStringIndex: 0,
    value: { case: 'booleanValue' as const, value: true },
  }
  const split = {
    ranges: [],
    variationIndex: 0,
    serialId: 1,
    reason: Reason.TARGETING_MATCH,
  }
  const flags = Object.fromEntries(
    ['root', ...dependencyKeys].map((key, index) => [
      key,
      {
        variationType: VariationType.BOOLEAN,
        variations: [variation],
        allocations: [
          {
            key: `${key}-allocation`,
            ...(index < edgeCount ? { targetingConditionIndex: index } : {}),
            partitionKey: [],
            splits: [{ ...split, reason: index < edgeCount ? Reason.TARGETING_MATCH : Reason.STATIC }],
            logExposureEvent: true,
          },
        ],
      },
    ])
  )

  return decodeFlagsConfiguration(
    encodeFlagsConfiguration(
      create(FlagsConfigurationSchema, {
        environmentName: 'test',
        strings: ['on', ...dependencyKeys],
        conditions: dependencyKeys.map((_, index) => ({
          kind: {
            case: 'flagEvaluationStringMembership' as const,
            value: { flagKeyStringIndex: index + 1, variantKeyStringIndexes: [0], negate: false },
          },
        })),
        flags,
      })
    )
  )
}

function roundTrip(configuration: Parameters<typeof encodeFlagsConfiguration>[0]) {
  return decodeFlagsConfiguration(encodeFlagsConfiguration(configuration))
}

function evaluateProtobuf(configuration: ReturnType<typeof decodeFlagsConfiguration>, logger: Logger) {
  const trace = evaluateRulesBasedConfigurationWithTrace(
    configuration,
    'boolean',
    'root',
    false,
    { targetingKey: 'subject' },
    logger
  )
  return {
    result: trace.details,
    dependencies: trace.dependencyEvaluations,
    exposures: trace.dependencyExposures,
  }
}
