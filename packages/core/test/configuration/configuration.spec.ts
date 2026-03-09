import { configMatchesContext, type FlagsConfiguration } from '../../src/configuration/configuration'

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
})
