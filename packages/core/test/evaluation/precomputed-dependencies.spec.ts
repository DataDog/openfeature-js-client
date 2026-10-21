import { type FlagsConfiguration, type PrecomputedConfigurationResponse } from '../../src/configuration'
import { parsePrecomputedConfigurationResponse } from '../../src/configuration/wire-validation'
import { getPrecomputedDependencyEvaluations } from '../../src/evaluation/precomputed-dependencies'
import { evaluatePrecomputedConfiguration } from '../../src/evaluation/precomputed-evaluation'

const context = { targetingKey: 'subject' }

function configuration(flag: Record<string, unknown>): FlagsConfiguration {
  return {
    precomputed: {
      context,
      response: {
        data: {
          attributes: {
            createdAt: '2026-10-21T00:00:00Z',
            flags: { root: flag },
          },
        },
      } as unknown as PrecomputedConfigurationResponse,
    },
  }
}

describe('precomputed dependent flags', () => {
  const successfulDependency = {
    flagKey: 'parent',
    allocationKey: 'parent-allocation',
    variationKey: 'parent-on',
    reason: 'TARGETING_MATCH',
    doLog: true,
    serialId: 42,
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
        flagMetadata: {
          allocationKey: 'parent-allocation',
          doLog: true,
          __dd_split_serial_id: 42,
        },
      },
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

  it.each([
    { reason: 'ERROR' },
    { reason: 'ERROR', errorCode: 12 },
    { reason: 'TARGETING_MATCH', errorCode: 'GENERAL' },
    { reason: 'ERROR', errorCode: 'GENERAL', dependencyEvaluations: {} },
    { reason: 'ERROR', errorCode: 'GENERAL', dependencyEvaluations: [{ flagKey: 'parent', reason: 'ERROR' }] },
  ])('isolates malformed root or dependency records: %j', (flag) => {
    const payload = configuration(flag).precomputed!.response
    expect(parsePrecomputedConfigurationResponse(payload)).toEqual({
      response: payload,
      flagErrors: { root: 'Invalid precomputed flag configuration' },
    })
  })
})
