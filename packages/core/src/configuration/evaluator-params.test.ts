import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import type { Logger } from '@openfeature/core'
import type { UniversalFlagConfigurationV1 } from '../evaluation/ufc-v1'
import { EvaluatorParams } from './evaluator-params'
import { EvaluatorParamsSchema, FlagsConfigurationSchema } from './generated/ufc_pb'
import { prepareUniversalFlagConfigurationForEvaluation } from './prepared-activation'
import { prepareRulesResponse } from './prepared-rules-response'

describe('EvaluatorParams', () => {
  let logger: Pick<Logger, 'warn'>

  beforeEach(() => {
    logger = { warn: jest.fn() }
  })

  it.each([
    [undefined, 10],
    [{}, 10],
    [{ maxDependencyDepth: 0 }, 0],
    [{ maxDependencyDepth: 255 }, 255],
  ])('prepares JSON evaluator parameters %#', (input, expected) => {
    expect(EvaluatorParams.fromJson(input, logger).effectiveMaxDependencyDepth).toBe(expected)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it.each([null, [], 'options', { maxDependencyDepth: -1 }, { maxDependencyDepth: 1.5 }, { maxDependencyDepth: 256 }])(
    'uses the default for malformed JSON evaluator parameters %#',
    (input) => {
      expect(EvaluatorParams.fromJson(input, logger).effectiveMaxDependencyDepth).toBe(10)
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith('Invalid evaluatorParams; using default maxDependencyDepth', {
        defaultMaxDependencyDepth: 10,
      })
    }
  )

  it('uses the default when reading JSON evaluator parameters throws', () => {
    const input = Object.defineProperty({}, 'maxDependencyDepth', {
      get() {
        throw new Error('broken getter')
      },
    })

    expect(EvaluatorParams.fromJson(input, logger).effectiveMaxDependencyDepth).toBe(10)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('uses the default when the JSON evaluator parameters block cannot be inspected', () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()

    expect(EvaluatorParams.fromJson(proxy, logger).effectiveMaxDependencyDepth).toBe(10)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('reads a JSON configuration evaluator parameters accessor once', () => {
    const read = jest.fn(() => ({ maxDependencyDepth: 2 }))
    const configuration = Object.defineProperty({}, 'evaluatorParams', { get: read })

    expect(EvaluatorParams.fromJsonConfiguration(configuration, logger).effectiveMaxDependencyDepth).toBe(2)
    expect(read).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('uses the default when a JSON configuration evaluator parameters accessor throws', () => {
    const configuration = Object.defineProperty({}, 'evaluatorParams', {
      get() {
        throw new Error('broken evaluatorParams')
      },
    })

    expect(EvaluatorParams.fromJsonConfiguration(configuration, logger).effectiveMaxDependencyDepth).toBe(10)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it.each([
    [undefined, 10],
    [create(EvaluatorParamsSchema), 10],
    [create(EvaluatorParamsSchema, { maxDependencyDepth: BigInt(0) }), 0],
    [create(EvaluatorParamsSchema, { maxDependencyDepth: BigInt(255) }), 255],
  ])('prepares protobuf evaluator parameters %#', (input, expected) => {
    expect(EvaluatorParams.fromProtobuf(input, logger).effectiveMaxDependencyDepth).toBe(expected)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it.each([BigInt(-1), BigInt(256)])('uses the default for out-of-range protobuf evaluator parameter %s', (depth) => {
    const input = create(EvaluatorParamsSchema, { maxDependencyDepth: depth })

    expect(EvaluatorParams.fromProtobuf(input, logger).effectiveMaxDependencyDepth).toBe(10)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it.each([null, [], 'options', 42])('warns once for a malformed protobuf evaluator parameters block %#', (input) => {
    expect(EvaluatorParams.fromProtobuf(input as never, logger).effectiveMaxDependencyDepth).toBe(10)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('Invalid evaluatorParams; using default maxDependencyDepth', {
      defaultMaxDependencyDepth: 10,
    })
  })

  it('reads a protobuf configuration evaluator parameters accessor once', () => {
    const read = jest.fn(() => create(EvaluatorParamsSchema, { maxDependencyDepth: BigInt(2) }))
    const configuration = Object.defineProperty({}, 'evaluatorParams', { get: read })

    expect(EvaluatorParams.fromProtobufConfiguration(configuration, logger).effectiveMaxDependencyDepth).toBe(2)
    expect(read).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('uses the default when a protobuf configuration evaluator parameters accessor throws', () => {
    const configuration = Object.defineProperty({}, 'evaluatorParams', {
      get() {
        throw new Error('broken evaluatorParams')
      },
    })

    expect(EvaluatorParams.fromProtobufConfiguration(configuration, logger).effectiveMaxDependencyDepth).toBe(10)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('does not let a warning failure prevent preparation', () => {
    const throwingLogger = {
      warn() {
        throw new Error('logger failed')
      },
    }

    expect(EvaluatorParams.fromJson(null, throwingLogger).effectiveMaxDependencyDepth).toBe(10)
  })

  it('keeps prepared JSON evaluator parameters out of the serializable source', () => {
    const source: UniversalFlagConfigurationV1 = {
      createdAt: '2026-11-09T00:00:00Z',
      format: 'SERVER',
      environment: { name: 'test' },
      flags: {},
      evaluatorParams: { maxDependencyDepth: 256 },
    }
    const before = JSON.stringify(source)

    const prepared = prepareUniversalFlagConfigurationForEvaluation(source, logger)

    expect(prepared.evaluatorParams.effectiveMaxDependencyDepth).toBe(10)
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(
      Reflect.set(prepared, 'evaluatorParams', EvaluatorParams.fromJson({ maxDependencyDepth: 200 }, logger))
    ).toBe(false)
    expect(prepared.evaluatorParams.effectiveMaxDependencyDepth).toBe(10)
    expect(prepared.source).toBe(source)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('keeps prepared protobuf evaluator parameters out of the encoded message', () => {
    const source = create(FlagsConfigurationSchema, {
      evaluatorParams: create(EvaluatorParamsSchema, { maxDependencyDepth: BigInt(256) }),
    })

    const keys = Object.keys(source)
    const prepared = prepareRulesResponse(source, logger)
    const restored = fromBinary(FlagsConfigurationSchema, toBinary(FlagsConfigurationSchema, prepared))

    expect(prepared.preparedEvaluatorParams.effectiveMaxDependencyDepth).toBe(10)
    expect(Object.keys(prepared)).toEqual(keys)
    expect({ ...prepared }).not.toHaveProperty('preparedEvaluatorParams')
    expect(Object.getOwnPropertyDescriptor(prepared, 'preparedEvaluatorParams')).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
    })
    expect(Reflect.set(prepared, 'preparedEvaluatorParams', undefined)).toBe(false)
    expect(Reflect.deleteProperty(prepared, 'preparedEvaluatorParams')).toBe(false)
    expect(restored.evaluatorParams?.maxDependencyDepth).toBe(BigInt(256))
    expect(restored).not.toHaveProperty('preparedEvaluatorParams')
  })

  it('keeps effective evaluator parameters immutable at runtime', () => {
    const prepared = EvaluatorParams.fromJson({ maxDependencyDepth: 2 }, logger)

    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Reflect.set(prepared, 'effectiveMaxDependencyDepth', 200)).toBe(false)
    expect(prepared.effectiveMaxDependencyDepth).toBe(2)
  })

  it('does not accept inherited protobuf preparation state', () => {
    const source = create(FlagsConfigurationSchema)
    const inheritedState = Object.assign(Object.create(Object.getPrototypeOf(source)), {
      preparedEvaluatorParams: { effectiveMaxDependencyDepth: 200 },
      evaluationRegexCache: new Map(),
      evaluationJsonCache: new Map(),
      randomizationActivations: new Map(),
    })
    Object.setPrototypeOf(source, inheritedState)

    const prepared = prepareRulesResponse(source, logger)

    expect(Object.prototype.hasOwnProperty.call(prepared, 'preparedEvaluatorParams')).toBe(true)
    expect(prepared.preparedEvaluatorParams.effectiveMaxDependencyDepth).toBe(10)
  })

  it('adds evaluator parameters to a response prepared by an older core copy', () => {
    const source = create(FlagsConfigurationSchema)
    Object.defineProperties(source, {
      evaluationRegexCache: { value: new Map() },
      evaluationJsonCache: { value: new Map() },
      randomizationActivations: { value: new Map() },
    })

    expect(() => prepareRulesResponse(source, logger)).not.toThrow()
    expect(
      (source as ReturnType<typeof prepareRulesResponse>).preparedEvaluatorParams.effectiveMaxDependencyDepth
    ).toBe(10)
  })
})
