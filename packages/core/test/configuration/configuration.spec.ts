import { runInNewContext } from 'node:vm'
import type { EvaluationContext } from '@openfeature/core'
import { configMatchesContext, type FlagsConfiguration } from '../../src/configuration/configuration'

function configurationWithContext(context: EvaluationContext): FlagsConfiguration {
  return {
    precomputed: {
      response: { data: { attributes: { createdAt: '2024-01-01T00:00:00Z', flags: {} } } },
      context,
    },
  }
}

describe('configMatchesContext', () => {
  it('should handle Date values in context', () => {
    const date = new Date('2024-01-01T12:00:00Z')
    const context = { targetingKey: 'user123', timestamp: date }
    const config: FlagsConfiguration = {
      precomputed: {
        response: {
          data: {
            attributes: {
              createdAt: '2024-01-01T00:00:00Z',
              flags: {},
            },
          },
        },
        context,
      },
    }

    // Same date value should match
    expect(
      configMatchesContext(config, {
        targetingKey: 'user123',
        timestamp: new Date('2024-01-01T12:00:00Z'),
      })
    ).toBe(true)

    // Different date value should not match
    expect(
      configMatchesContext(config, {
        targetingKey: 'user123',
        timestamp: new Date('2024-01-01T13:00:00Z'),
      })
    ).toBe(false)
  })

  it.each(['top-level', 'nested'])('does not equate a %s Date with an empty record', (location) => {
    const dated: EvaluationContext = { timestamp: location === 'top-level' ? new Date(0) : { dates: [new Date(0)] } }
    const record: EvaluationContext = { timestamp: location === 'top-level' ? {} : { dates: [{}] } }

    expect(configMatchesContext(configurationWithContext(dated), record)).toBe(false)
    expect(configMatchesContext(configurationWithContext(record), dated)).toBe(false)
  })

  it.each([0, 1])('compares cross-realm Dates by timestamp: %s', (timestamp) => {
    const configuration = configurationWithContext({ timestamp: new Date(0) })
    expect(configMatchesContext(configuration, { timestamp: runInNewContext(`new Date(${timestamp})`) })).toBe(
      timestamp === 0
    )
  })

  it('uses the Date intrinsic instead of tags, prototypes, or instance methods', () => {
    const configuration = configurationWithContext({ timestamp: new Date(0) })
    const tagged = new Date(0)
    Object.defineProperty(tagged, Symbol.toStringTag, { value: 'Object' })
    tagged.getTime = () => {
      throw new Error('Instance method must not be used')
    }
    const changedPrototype = Object.setPrototypeOf(new Date(0), Object.prototype)
    const foreignTagged = runInNewContext(`
      const value = new Date(0);
      Object.defineProperty(value, Symbol.toStringTag, { value: 'Object' });
      value
    `)
    for (const timestamp of [tagged, changedPrototype, foreignTagged]) {
      expect(configMatchesContext(configuration, { timestamp })).toBe(true)
    }
    const fake = Object.defineProperty({}, Symbol.toStringTag, { value: 'Date' })
    expect(configMatchesContext(configuration, { timestamp: fake })).toBe(false)
  })
})
