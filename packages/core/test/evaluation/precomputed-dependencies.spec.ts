import {
  type FlagsConfiguration,
  type PrecomputedConfigurationResponse,
  type PrecomputedFlag,
} from '../../src/configuration'
import { encodePrecomputedFlagKey, type FlagKeyObfuscation } from '../../src/configuration/flag-key-obfuscation'
import { parsePrecomputedConfigurationResponse } from '../../src/configuration/wire-validation'
import { getPrecomputedDependencyEvaluations } from '../../src/evaluation/precomputed-dependencies'
import { evaluatePrecomputedConfiguration } from '../../src/evaluation/precomputed-evaluation'

const context = { targetingKey: 'subject' }

const parentFlag = {
  allocationKey: 'parent-allocation',
  variationKey: 'parent-on',
  variationType: 'boolean',
  variationValue: true,
  reason: 'TARGETING_MATCH',
  doLog: true,
  serialId: 42,
} satisfies PrecomputedFlag

function configuration(
  flag: Record<string, unknown>,
  additionalFlags: Record<string, unknown> = { parent: parentFlag }
): FlagsConfiguration {
  const isEvaluationError = flag.reason === 'ERROR' && !('variationValue' in flag)
  return {
    precomputed: {
      context,
      response: {
        data: {
          attributes: {
            createdAt: '2026-10-21T00:00:00Z',
            flags: { ...additionalFlags, ...(isEvaluationError ? {} : { root: flag }) },
            ...(isEvaluationError ? { flagEvaluationErrors: { root: flag } } : {}),
          },
        },
      } as unknown as PrecomputedConfigurationResponse,
    },
  }
}

describe('precomputed dependent flags', () => {
  const successfulDependency = {
    flagKey: 'parent',
    isPresentInAssignment: true,
  }

  it('returns the root assignment and preserves its ordered dependency evaluations', () => {
    const result = evaluatePrecomputedConfiguration(
      configuration({
        allocationKey: 'root-allocation',
        variationKey: 'root-on',
        variationType: 'boolean',
        variationValue: true,
        reason: 'TARGETING_MATCH',
        doLog: true,
        dependencyEvaluations: [successfulDependency],
      }),
      'boolean',
      'root',
      false,
      context
    )

    expect(result).toMatchObject({ value: true, variant: 'root-on', reason: 'TARGETING_MATCH' })
    expect(getPrecomputedDependencyEvaluations(result)).toEqual([
      {
        flagKey: 'parent',
        value: true,
        variant: 'parent-on',
        reason: 'TARGETING_MATCH',
        isPresentInAssignment: true,
        flagMetadata: {
          __dd_allocation_key: 'parent-allocation',
          __dd_do_log: true,
          __dd_eval_timestamp_ms: expect.any(Number),
          __dd_observe_full_evaluation_data: false,
          allocationKey: 'parent-allocation',
          doLog: true,
          __dd_split_serial_id: 42,
        },
      },
    ])
  })

  it.each([{}, [null], [{ flagKey: 'parent' }]])(
    'rejects malformed dependency traces in direct configurations: %j',
    (dependencyEvaluations) => {
      const result = evaluatePrecomputedConfiguration(
        configuration({
          allocationKey: 'root-allocation',
          variationKey: 'root-on',
          variationType: 'boolean',
          variationValue: true,
          reason: 'TARGETING_MATCH',
          doLog: true,
          dependencyEvaluations,
        }),
        'boolean',
        'root',
        false,
        context
      )

      expect(result).toMatchObject({
        value: false,
        reason: 'ERROR',
        errorCode: 'PARSE_ERROR',
        errorMessage: 'Invalid precomputed dependency evaluations',
      })
      expect(getPrecomputedDependencyEvaluations(result)).toEqual([])
    }
  )

  it('applies captured evaluation metadata to successful and failed prerequisites', () => {
    const flags = configuration({
      reason: 'ERROR',
      errorCode: 'GENERAL',
      dependencyEvaluations: [
        successfulDependency,
        { flagKey: 'missing-parent', reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' },
      ],
    })
    flags.precomputed!.response.data.attributes.observeFullEvaluationData = true

    const result = evaluatePrecomputedConfiguration(flags, 'boolean', 'root', false, context)
    const dependencies = getPrecomputedDependencyEvaluations(result)

    expect(dependencies).toHaveLength(2)
    for (const dependency of dependencies) {
      expect(dependency.flagMetadata).toMatchObject({
        __dd_eval_timestamp_ms: result.flagMetadata?.__dd_eval_timestamp_ms,
        __dd_observe_full_evaluation_data: true,
      })
    }
  })

  it('fails closed when a successful root contains a failed dependency evaluation', () => {
    const result = evaluatePrecomputedConfiguration(
      configuration({
        allocationKey: 'root-allocation',
        variationKey: 'root-on',
        variationType: 'boolean',
        variationValue: true,
        reason: 'TARGETING_MATCH',
        doLog: true,
        dependencyEvaluations: [{ flagKey: 'missing-parent', reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' }],
      }),
      'boolean',
      'root',
      false,
      context
    )

    expect(result).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
      errorMessage: 'Successful root assignment contains a failed dependency evaluation',
    })
  })

  it('treats nullable error fields on a successful dependency as absent', () => {
    const payload = configuration({
      allocationKey: 'root-allocation',
      variationKey: 'root-on',
      variationType: 'boolean',
      variationValue: true,
      reason: 'TARGETING_MATCH',
      doLog: true,
      dependencyEvaluations: [
        {
          flagKey: 'parent',
          isPresentInAssignment: true,
          reason: null,
          errorCode: null,
          errorMessage: null,
        },
      ],
    }).precomputed!.response
    const parsed = parsePrecomputedConfigurationResponse(payload)
    if ('error' in parsed) throw new Error(parsed.error)

    const result = evaluatePrecomputedConfiguration(
      { precomputed: { context, response: parsed.response, flagErrors: parsed.flagErrors } },
      'boolean',
      'root',
      false,
      context
    )

    expect(getPrecomputedDependencyEvaluations(result)).toEqual([
      expect.objectContaining({ flagKey: 'parent', value: true, variant: 'parent-on', reason: 'TARGETING_MATCH' }),
    ])
  })

  it('decrypts dependency identities before hashing them for top-level lookup', () => {
    const obfuscation: FlagKeyObfuscation = {
      scheme: 'flag-key-sha256-v1',
      salt: '00112233445566778899aabbccddeeff',
      dependencyKeyEncryption: { scheme: 'dependency-key-hkdf-sha256-aes-256-gcm-v1' },
    }
    const parentKey = encodePrecomputedFlagKey('parent', obfuscation)
    const rootKey = encodePrecomputedFlagKey('root', obfuscation)
    if ('error' in parentKey || 'error' in rootKey) throw new Error('test keys must encode')
    const flags: FlagsConfiguration = {
      precomputed: {
        context,
        response: {
          data: {
            attributes: {
              createdAt: '2026-10-21T00:00:00Z',
              obfuscated: true,
              obfuscation,
              flags: {
                [parentKey.key]: parentFlag,
                [rootKey.key]: {
                  allocationKey: 'root-allocation',
                  variationKey: 'root-on',
                  variationType: 'boolean',
                  variationValue: true,
                  reason: 'TARGETING_MATCH',
                  doLog: true,
                  dependencyEvaluations: [
                    {
                      flagKey: 'gM1Jf89VeabBzwfdAfy4uIKSOYeD4ZYYeuShN5lF4oKyGQ',
                      isPresentInAssignment: true,
                    },
                  ],
                },
              } satisfies Record<string, PrecomputedFlag>,
            },
          },
        },
      },
    }

    const result = evaluatePrecomputedConfiguration(flags, 'boolean', 'root', false, context)

    expect(getPrecomputedDependencyEvaluations(result)).toEqual([
      expect.objectContaining({ flagKey: 'parent', value: true, variant: 'parent-on' }),
    ])
  })

  it('preserves each dependency split feature for its destination', () => {
    const result = evaluatePrecomputedConfiguration(
      configuration(
        {
          allocationKey: 'root-allocation',
          variationKey: 'root-on',
          variationType: 'boolean',
          variationValue: true,
          reason: 'TARGETING_MATCH',
          doLog: true,
          dependencyEvaluations: [successfulDependency],
        },
        {
          parent: {
            ...parentFlag,
            features: [
              { key: 'hook', value: 'h', destinations: ['HOOK'] },
              { key: 'exposure', value: 2, destinations: ['EXPOSURE'] },
              { key: 'evaluation', value: true, destinations: ['EVALUATION'] },
            ],
          },
        }
      ),
      'boolean',
      'root',
      false,
      context
    )

    expect(getPrecomputedDependencyEvaluations(result)[0].flagMetadata).toMatchObject({
      '__dd_feature.hook': 'h',
      '__dd_exposure_feature.exposure': 2,
      '__dd_evaluation_feature.evaluation': true,
      __dd_has_evaluation_features: true,
    })
  })

  it('resolves successful details from the top-level assignment and retains rejected-path membership', () => {
    const result = evaluatePrecomputedConfiguration(
      configuration({
        allocationKey: 'root-allocation',
        variationKey: 'root-on',
        variationType: 'boolean',
        variationValue: true,
        reason: 'TARGETING_MATCH',
        doLog: true,
        dependencyEvaluations: [{ flagKey: 'parent', isPresentInAssignment: false }],
      }),
      'boolean',
      'root',
      false,
      context
    )

    expect(getPrecomputedDependencyEvaluations(result)).toEqual([
      expect.objectContaining({
        flagKey: 'parent',
        variant: 'parent-on',
        isPresentInAssignment: false,
        flagMetadata: expect.objectContaining({ allocationKey: 'parent-allocation', doLog: true }),
      }),
    ])
  })

  it.each([true, false])(
    'fails the root when a successful dependency reference is unresolved (selected: %s)',
    (isPresentInAssignment) => {
      const result = evaluatePrecomputedConfiguration(
        configuration(
          {
            allocationKey: 'root-allocation',
            variationKey: 'root-on',
            variationType: 'boolean',
            variationValue: true,
            reason: 'TARGETING_MATCH',
            doLog: true,
            dependencyEvaluations: [{ flagKey: 'absent-parent', isPresentInAssignment }],
          },
          {}
        ),
        'boolean',
        'root',
        false,
        context
      )

      expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'PARSE_ERROR' })
      expect(getPrecomputedDependencyEvaluations(result)).toEqual([])
    }
  )

  it('does not reconstruct a successful dependency from a quarantined top-level assignment', () => {
    const root = {
      allocationKey: 'root-allocation',
      variationKey: 'root-on',
      variationType: 'boolean',
      variationValue: true,
      reason: 'TARGETING_MATCH',
      doLog: true,
      dependencyEvaluations: [{ flagKey: 'parent', isPresentInAssignment: true }],
    }
    const payload = configuration(root, { parent: { ...parentFlag, variationValue: 'not-a-boolean' } }).precomputed!
      .response
    const parsed = parsePrecomputedConfigurationResponse(payload)
    if ('error' in parsed) throw new Error(parsed.error)
    const result = evaluatePrecomputedConfiguration(
      { precomputed: { context, response: parsed.response, flagErrors: parsed.flagErrors } },
      'boolean',
      'root',
      false,
      context
    )

    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'PARSE_ERROR' })
    expect(getPrecomputedDependencyEvaluations(result)).toEqual([])
  })

  it('does not reconstruct a malformed application-supplied prerequisite assignment', () => {
    const root = {
      allocationKey: 'root-allocation',
      variationKey: 'root-on',
      variationType: 'boolean',
      variationValue: true,
      reason: 'TARGETING_MATCH',
      doLog: true,
      dependencyEvaluations: [successfulDependency],
    }
    const result = evaluatePrecomputedConfiguration(
      configuration(root, { parent: { ...parentFlag, variationValue: 'not-a-boolean' } }),
      'boolean',
      'root',
      false,
      context
    )

    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'PARSE_ERROR' })
    expect(getPrecomputedDependencyEvaluations(result)).toEqual([])
  })

  it('does not reconstruct an ERROR assignment as a successful dependency', () => {
    const root = {
      allocationKey: 'root-allocation',
      variationKey: 'root-on',
      variationType: 'boolean',
      variationValue: true,
      reason: 'TARGETING_MATCH',
      doLog: true,
      dependencyEvaluations: [successfulDependency],
    }
    const invalidParent = { ...parentFlag, reason: 'ERROR' }

    const direct = evaluatePrecomputedConfiguration(
      configuration(root, { parent: invalidParent }),
      'boolean',
      'root',
      false,
      context
    )
    expect(direct).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'PARSE_ERROR' })
    expect(getPrecomputedDependencyEvaluations(direct)).toEqual([])

    const payload = configuration(root, { parent: invalidParent }).precomputed!.response
    const parsed = parsePrecomputedConfigurationResponse(payload)
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.flagErrors).toEqual({ parent: 'Invalid precomputed flag configuration' })
  })

  it('returns the caller default while preserving reached dependency errors', () => {
    const result = evaluatePrecomputedConfiguration(
      configuration({
        reason: 'ERROR',
        errorCode: 'GENERAL',
        dependencyEvaluations: [
          successfulDependency,
          { flagKey: 'missing-parent', reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' },
          { flagKey: 'failed-ancestor', reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' },
        ],
      }),
      'boolean',
      'root',
      false,
      context
    )

    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'GENERAL' })
    expect(getPrecomputedDependencyEvaluations(result)).toEqual([
      expect.objectContaining({ flagKey: 'parent', variant: 'parent-on' }),
      expect.objectContaining({ flagKey: 'missing-parent', reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' }),
      expect.objectContaining({ flagKey: 'failed-ancestor', reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' }),
    ])
  })

  it.each([
    { reason: 'ERROR' },
    { reason: 'STATIC', errorCode: 'GENERAL' },
    { reason: 'ERROR', errorCode: 12 },
    { reason: 'ERROR', errorCode: 'GENERAL', errorMessage: 12 },
    null,
    false,
    0,
    '',
    undefined,
  ])('rejects malformed direct evaluation errors: %j', (malformedError) => {
    const flags = configuration({ reason: 'ERROR', errorCode: 'GENERAL' })
    flags.precomputed!.response.data.attributes.flagEvaluationErrors!.root = malformedError as never

    expect(evaluatePrecomputedConfiguration(flags, 'boolean', 'root', false, context)).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
      errorMessage: 'Invalid precomputed flag evaluation error',
    })
  })

  it('preserves reached dependencies when the caller uses the wrong typed API', () => {
    const result = evaluatePrecomputedConfiguration(
      configuration({
        allocationKey: 'root-allocation',
        variationKey: 'root-on',
        variationType: 'boolean',
        variationValue: true,
        reason: 'TARGETING_MATCH',
        doLog: true,
        dependencyEvaluations: [successfulDependency],
      }),
      'string',
      'root',
      'default',
      context
    )

    expect(result).toMatchObject({ value: 'default', reason: 'ERROR', errorCode: 'TYPE_MISMATCH' })
    expect(getPrecomputedDependencyEvaluations(result)).toEqual([
      expect.objectContaining({ flagKey: 'parent', variant: 'parent-on' }),
    ])
  })

  it('preserves a terminal no-assignment prerequisite error without inventing a top-level assignment', () => {
    const flags = configuration(
      {
        reason: 'ERROR',
        errorCode: 'GENERAL',
        dependencyEvaluations: [{ flagKey: 'no-assignment-parent', reason: 'ERROR', errorCode: 'GENERAL' }],
      },
      {}
    )
    const root = evaluatePrecomputedConfiguration(flags, 'boolean', 'root', false, context)
    const standalone = evaluatePrecomputedConfiguration(flags, 'boolean', 'no-assignment-parent', false, context)

    expect(root).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'GENERAL' })
    expect(getPrecomputedDependencyEvaluations(root)).toEqual([
      {
        flagKey: 'no-assignment-parent',
        reason: 'ERROR',
        errorCode: 'GENERAL',
        flagMetadata: {
          __dd_eval_timestamp_ms: expect.any(Number),
          __dd_observe_full_evaluation_data: false,
        },
      },
    ])
    expect(standalone).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' })
  })

  it.each([
    { reason: 'ERROR' },
    { reason: 'ERROR', errorCode: 12 },
    { reason: 'TARGETING_MATCH', errorCode: 'GENERAL' },
    { reason: 'ERROR', errorCode: 'GENERAL', dependencyEvaluations: {} },
    { reason: 'ERROR', errorCode: 'GENERAL', dependencyEvaluations: [{ flagKey: 'parent', reason: 'ERROR' }] },
    {
      reason: 'ERROR',
      errorCode: 'GENERAL',
      dependencyEvaluations: [
        { flagKey: 'parent', reason: 'ERROR', errorCode: 'GENERAL', isPresentInAssignment: false },
      ],
    },
    {
      reason: 'ERROR',
      errorCode: 'GENERAL',
      dependencyEvaluations: [{ flagKey: 'parent', isPresentInAssignment: 'yes' }],
    },
    {
      reason: 'ERROR',
      errorCode: 'GENERAL',
      dependencyEvaluations: [
        {
          flagKey: 'parent',
          allocationKey: 'duplicated-allocation',
          variationKey: 'duplicated-variation',
          reason: 'TARGETING_MATCH',
          doLog: true,
        },
      ],
    },
    {
      reason: 'ERROR',
      errorCode: 'GENERAL',
      dependencyEvaluations: [
        { flagKey: 'parent', isPresentInAssignment: true },
        { flagKey: 'parent', isPresentInAssignment: false },
      ],
    },
  ])('isolates malformed root or dependency records: %j', (flag) => {
    const payload = configuration(flag).precomputed!.response
    expect(parsePrecomputedConfigurationResponse(payload)).toEqual({
      response: payload,
      flagErrors: {
        root:
          flag.reason === 'ERROR'
            ? 'Invalid precomputed flag evaluation error'
            : 'Invalid precomputed flag configuration',
      },
    })
  })

  it('rejects a flag key present in both assignments and evaluation errors', () => {
    const response = configuration(parentFlag).precomputed!.response
    const payload = {
      ...response,
      data: {
        ...response.data,
        attributes: {
          ...response.data.attributes,
          flagEvaluationErrors: {
            root: { reason: 'ERROR', errorCode: 'GENERAL', dependencyEvaluations: [] },
          },
        },
      },
    }

    expect(parsePrecomputedConfigurationResponse(payload)).toEqual({
      error: 'A precomputed flag cannot have both an assignment and an evaluation error',
    })
  })

  it('rejects a direct configuration with a dependency in both maps', () => {
    const flags = configuration(
      {
        allocationKey: 'root-allocation',
        variationKey: 'root-on',
        variationType: 'boolean',
        variationValue: true,
        reason: 'TARGETING_MATCH',
        doLog: true,
        dependencyEvaluations: [successfulDependency],
      },
      { parent: parentFlag }
    )
    flags.precomputed!.response.data.attributes.flagEvaluationErrors = {
      parent: { reason: 'ERROR', errorCode: 'GENERAL', dependencyEvaluations: [] },
    }

    expect(evaluatePrecomputedConfiguration(flags, 'boolean', 'root', false, context)).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
      errorMessage: 'A precomputed flag cannot have both an assignment and an evaluation error',
    })
  })

  it('rejects a malformed direct dependency error entry', () => {
    const flags = configuration(
      {
        reason: 'ERROR',
        errorCode: 'GENERAL',
        dependencyEvaluations: [{ flagKey: 'parent', reason: 'ERROR', errorCode: 'GENERAL' }],
      },
      {}
    )
    flags.precomputed!.response.data.attributes.flagEvaluationErrors = {
      ...flags.precomputed!.response.data.attributes.flagEvaluationErrors,
      parent: null as never,
    }

    expect(evaluatePrecomputedConfiguration(flags, 'boolean', 'root', false, context)).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
      errorMessage: 'Invalid precomputed flag evaluation error',
    })
  })

  it('preserves an inline dependency error alongside its standalone assignment', () => {
    const flags = configuration({
      reason: 'ERROR',
      errorCode: 'GENERAL',
      dependencyEvaluations: [
        { flagKey: 'parent', reason: 'ERROR', errorCode: 'GENERAL', errorMessage: 'Path-specific failure' },
      ],
    })

    const result = evaluatePrecomputedConfiguration(flags, 'boolean', 'root', false, context)
    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'GENERAL' })
    expect(getPrecomputedDependencyEvaluations(result)).toEqual([
      {
        flagKey: 'parent',
        reason: 'ERROR',
        errorCode: 'GENERAL',
        errorMessage: 'Path-specific failure',
        flagMetadata: {
          __dd_eval_timestamp_ms: expect.any(Number),
          __dd_observe_full_evaluation_data: false,
        },
      },
    ])
  })
})
