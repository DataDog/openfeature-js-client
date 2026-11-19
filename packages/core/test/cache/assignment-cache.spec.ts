import { NonExpiringInMemoryAssignmentCache } from '../../src/cache/non-expiring-in-memory-cache-assignment'
import type { ExposureEvent } from '../../src/configuration'

function exposure(attributes: ExposureEvent['subject']['attributes'], variant = 'A'): ExposureEvent {
  return {
    flag: { key: 'flag' },
    subject: { id: 'subject', attributes },
    allocation: { key: 'allocation' },
    variant: { key: variant },
  }
}

describe('assignment cache identity', () => {
  it('retains the latest assignment when a subject returns to an earlier context', () => {
    const cache = new NonExpiringInMemoryAssignmentCache()
    const first = exposure({ plan: 'free' })
    const second = exposure({ plan: 'paid' }, 'B')
    cache.set(first)
    cache.set(second)
    expect(cache.has(second)).toBe(true)
    expect(cache.has(first)).toBe(false)
    cache.set(first)
    expect(cache.has(first)).toBe(true)
    expect(cache.has(second)).toBe(false)
  })

  it('ignores object property order, including nested attributes', () => {
    const cache = new NonExpiringInMemoryAssignmentCache()
    const first = exposure({ plan: 'free', profile: { region: 'us', age: 30 } })
    cache.set(first)
    expect(
      cache.has({
        variant: first.variant,
        allocation: first.allocation,
        subject: { id: 'subject', attributes: { profile: { age: 30, region: 'us' }, plan: 'free' } },
        flag: first.flag,
      })
    ).toBe(true)
  })

  it('preserves array order and serial ID as exposure differences', () => {
    const cache = new NonExpiringInMemoryAssignmentCache()
    const first = { ...exposure({ groups: ['a', 'b'] }), serial_id: 1 }
    cache.set(first)
    expect(cache.has({ ...first, serial_id: 2 })).toBe(false)
    expect(cache.has({ ...first, subject: { id: 'subject', attributes: { groups: ['b', 'a'] } } })).toBe(false)
  })
})
