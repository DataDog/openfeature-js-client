import type { ExposureEvent } from '../../../core/src/configuration/exposureEvent.types'
import { LocalStorageAssignmentCache } from '../../src/cache/local-storage-assignment-cache'

describe('LocalStorageAssignmentCache', () => {
  it('typical behavior', () => {
    const cache = new LocalStorageAssignmentCache('test')

    const exposureEvent1: ExposureEvent = {
      subject: { id: 'subject-1', attributes: {} },
      flag: { key: 'flag-1' },
      allocation: { key: 'allocation-1' },
      variant: { key: 'control' },
    }

    expect(cache.has(exposureEvent1)).toEqual(false)

    cache.set(exposureEvent1)

    expect(cache.has(exposureEvent1)).toEqual(true) // this key has been logged

    // change variation
    const exposureEvent2: ExposureEvent = {
      subject: { id: 'subject-1', attributes: {} },
      flag: { key: 'flag-1' },
      allocation: { key: 'allocation-1' },
      variant: { key: 'variant' },
    }

    cache.set(exposureEvent2)

    expect(cache.has(exposureEvent1)).toEqual(false) // this key has not been logged
  })

  it('can have independent caches', () => {
    const storageKeySuffixA = 'A'
    const storageKeySuffixB = 'B'
    const cacheA = new LocalStorageAssignmentCache(storageKeySuffixA)
    const cacheB = new LocalStorageAssignmentCache(storageKeySuffixB)

    const exposureEventA: ExposureEvent = {
      subject: { id: 'subject-1', attributes: {} },
      flag: { key: 'flag-1' },
      allocation: { key: 'allocation-1' },
      variant: { key: 'variation-A' },
    }

    const exposureEventB: ExposureEvent = {
      subject: { id: 'subject-1', attributes: {} },
      flag: { key: 'flag-1' },
      allocation: { key: 'allocation-1' },
      variant: { key: 'variation-B' },
    }

    cacheA.set(exposureEventA)

    expect(cacheA.has(exposureEventA)).toEqual(true)

    expect(cacheB.has(exposureEventA)).toEqual(false)

    cacheB.set(exposureEventB)

    expect(cacheA.has(exposureEventA)).toEqual(true)

    expect(cacheB.has(exposureEventA)).toEqual(false)

    expect(cacheA.has(exposureEventB)).toEqual(false)

    expect(cacheB.has(exposureEventB)).toEqual(true)
  })
})
