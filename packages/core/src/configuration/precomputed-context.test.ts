import type { EvaluationContext } from '@openfeature/core'
import type { FlagsConfiguration } from './configuration'
import { getPrecomputedContext } from './precomputed-context'

function configurationWithContext(context?: EvaluationContext): FlagsConfiguration {
  return {
    precomputed: {
      response: {
        data: {
          attributes: {
            createdAt: '2026-08-05T00:00:00.000Z',
            flags: {},
          },
        },
      },
      ...(context === undefined ? {} : { context }),
    },
  }
}

describe('getPrecomputedContext', () => {
  it('returns the context from a precomputed configuration', () => {
    expect(
      getPrecomputedContext(
        configurationWithContext({
          targetingKey: 'user-1',
          country: 'US',
        })
      )
    ).toEqual({ targetingKey: 'user-1', country: 'US' })
  })

  it('preserves an explicit empty context and an empty targeting key', () => {
    expect(getPrecomputedContext(configurationWithContext({}))).toEqual({})
    expect(getPrecomputedContext(configurationWithContext({ targetingKey: '' }))).toEqual({ targetingKey: '' })
  })

  it('returns a deep copy of the context', () => {
    const date = new Date('2026-08-05T00:00:00.000Z')
    const configuration = configurationWithContext({
      targetingKey: 'user-1',
      profile: {
        groups: ['beta', { name: 'mobile' }],
        enrolledAt: date,
      },
    })

    const first = getPrecomputedContext(configuration) as EvaluationContext
    const firstProfile = first.profile as {
      groups: Array<string | { name: string }>
      enrolledAt: Date
    }
    firstProfile.groups[1] = { name: 'changed' }
    firstProfile.enrolledAt.setUTCFullYear(2030)

    const second = getPrecomputedContext(configuration)
    expect(second).toEqual({
      targetingKey: 'user-1',
      profile: {
        groups: ['beta', { name: 'mobile' }],
        enrolledAt: date,
      },
    })
    expect(second).not.toBe(first)
    expect((second?.profile as { groups: unknown[] }).groups).not.toBe(firstProfile.groups)
    expect((second?.profile as { enrolledAt: Date }).enrolledAt).not.toBe(date)
  })

  it.each([
    ['an empty configuration', {}],
    ['a rules-only configuration', { rules: { response: {} } }],
    [
      'an invalid precomputed branch with valid rules',
      { precomputedError: 'invalid precomputed branch', rules: { response: {} } },
    ],
  ])('returns undefined for %s', (_name, configuration) => {
    expect(getPrecomputedContext(configuration as FlagsConfiguration)).toBeUndefined()
  })

  it('returns undefined for a context-agnostic precomputed configuration', () => {
    expect(getPrecomputedContext(configurationWithContext())).toBeUndefined()
  })

  it('returns the precomputed context from a mixed configuration', () => {
    const configuration = {
      ...configurationWithContext({ targetingKey: 'user-1' }),
      rules: { response: {} },
    } as FlagsConfiguration

    expect(getPrecomputedContext(configuration)).toEqual({ targetingKey: 'user-1' })
  })
})
