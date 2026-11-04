import { type FlagsConfiguration, type PrecomputedConfigurationResponse } from '../../src/configuration'
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
}

function configuration(
  flag: Record<string, unknown>,
  additionalFlags: Record<string, unknown> = { parent: parentFlag }
): FlagsConfiguration {
  return {
    precomputed: {
      context,
      response: {
        data: {
          attributes: {
            createdAt: '2026-10-21T00:00:00Z',
            flags: { ...additionalFlags, root: flag },
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

  it('turns an unresolved successful dependency reference into parse-error telemetry', () => {
    const result = evaluatePrecomputedConfiguration(
      configuration(
        {
          allocationKey: 'root-allocation',
          variationKey: 'root-on',
          variationType: 'boolean',
          variationValue: true,
          reason: 'TARGETING_MATCH',
          doLog: true,
          dependencyEvaluations: [{ flagKey: 'absent-parent', isPresentInAssignment: true }],
        },
        {}
      ),
      'boolean',
      'root',
      false,
      context
    )

    expect(getPrecomputedDependencyEvaluations(result)).toEqual([
      expect.objectContaining({ flagKey: 'absent-parent', reason: 'ERROR', errorCode: 'PARSE_ERROR' }),
    ])
  })

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

    expect(getPrecomputedDependencyEvaluations(result)).toEqual([
      expect.objectContaining({ flagKey: 'parent', reason: 'ERROR', errorCode: 'PARSE_ERROR' }),
    ])
  })

  it('returns the caller default while preserving reached dependency errors', () => {
    const result = evaluatePrecomputedConfiguration(
      configuration({
        reason: 'ERROR',
        errorCode: 'FLAG_NOT_FOUND',
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

    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' })
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
      flagErrors: { root: 'Invalid precomputed flag configuration' },
    })
  })
})
