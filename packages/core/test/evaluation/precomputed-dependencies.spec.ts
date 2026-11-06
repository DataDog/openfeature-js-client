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
          allocationKey: 'parent-allocation',
          doLog: true,
          __dd_split_serial_id: 42,
        },
      },
    ])
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
                      flagKey: 'Dnh0eaLWDiAaLkwLG6hAV7Q-rU7_xMvXou2PWK3dCjz9rg',
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
        flagMetadata: {},
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
})
