import { parsePrecomputedConfigurationResponse } from './wire-validation'

const assignment = {
  allocationKey: 'allocation',
  variationKey: 'on',
  variationType: 'boolean',
  variationValue: true,
  reason: 'STATIC',
  doLog: false,
}

const failure = {
  reason: 'ERROR',
  errorCode: 'GENERAL',
  dependencyEvaluations: [{ flagKey: 'parent', reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' }],
}

function response(flags: unknown = {}, flagEvaluationErrors?: unknown) {
  return {
    data: {
      attributes: {
        createdAt: '2026-11-06T00:00:00Z',
        flags,
        ...(flagEvaluationErrors === undefined ? {} : { flagEvaluationErrors }),
      },
    },
  }
}

describe('precomputed dependency wire validation', () => {
  it('accepts disjoint assignments and failures with dependency traces', () => {
    expect(parsePrecomputedConfigurationResponse(response({ assigned: assignment }, { failed: failure }))).toEqual({
      response: response({ assigned: assignment }, { failed: failure }),
    })
  })

  it('rejects a key present in both result maps', () => {
    expect(parsePrecomputedConfigurationResponse(response({ flag: assignment }, { flag: failure }))).toEqual({
      error: 'A precomputed flag cannot have both an assignment and an evaluation error',
    })
  })

  it.each([null, [], 'errors'])('rejects a non-record error map: %j', (flagEvaluationErrors) => {
    expect(parsePrecomputedConfigurationResponse(response({}, flagEvaluationErrors))).toEqual({
      error: 'Precomputed configuration flagEvaluationErrors must be an object',
    })
  })

  it.each([
    {},
    { reason: 'ERROR' },
    { ...failure, reason: 'STATIC' },
    { ...failure, dependencyEvaluations: {} },
    {
      ...failure,
      dependencyEvaluations: [
        { flagKey: 'parent', isPresentInAssignment: false },
        { flagKey: 'parent', reason: 'ERROR', errorCode: 'GENERAL' },
      ],
    },
    {
      ...failure,
      dependencyEvaluations: [
        { flagKey: 'parent', reason: 'ERROR', errorCode: 'GENERAL', isPresentInAssignment: false },
      ],
    },
  ])('retains a per-flag parse error for malformed failure %j', (malformed) => {
    expect(parsePrecomputedConfigurationResponse(response({}, { failed: malformed }))).toEqual({
      response: response({}, { failed: malformed }),
      flagErrors: { failed: 'Invalid precomputed flag evaluation error' },
    })
  })

  it('rejects plaintext dependency keys in an obfuscated packet', () => {
    const encoded = response({}, { ['a'.repeat(64)]: failure })
    encoded.data.attributes = {
      ...encoded.data.attributes,
      obfuscated: true,
      obfuscation: { scheme: 'flag-key-sha256-v1', salt: '0'.repeat(32) },
    } as typeof encoded.data.attributes

    expect(parsePrecomputedConfigurationResponse(encoded)).toEqual({
      response: encoded,
      flagErrors: { ['a'.repeat(64)]: 'Invalid precomputed flag evaluation error' },
    })
  })
})
