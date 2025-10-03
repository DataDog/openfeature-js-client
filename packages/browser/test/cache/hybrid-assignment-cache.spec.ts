/**
 * @jest-environment jsdom
 */

import type { ExposureEvent } from '../../../core/src/configuration/exposureEvent.types'
import ChromeStorageAssignmentCache from '../../src/cache/chrome-storage-assignment-cache'
import HybridAssignmentCache from '../../src/cache/hybrid-assignment-cache'
import { LocalStorageAssignmentCache } from '../../src/cache/local-storage-assignment-cache'

import StorageArea = chrome.storage.StorageArea

describe('HybridStorageAssignmentCache', () => {
  const fakeStore: Record<string, string> = {}

  const get = jest.fn((key?: string) => {
    return new Promise((resolve) => {
      if (!key) {
        resolve(fakeStore)
      } else {
        resolve({ [key]: fakeStore[key] })
      }
    })
  }) as jest.Mock

  const set = jest.fn((items: { [key: string]: string }) => {
    return new Promise((resolve) => {
      Object.assign(fakeStore, items)
      resolve(undefined)
    })
  }) as jest.Mock

  const mockChromeStorage = { get, set } as unknown as StorageArea
  const chromeStorageCache = new ChromeStorageAssignmentCache(mockChromeStorage)
  const localStorageCache = new LocalStorageAssignmentCache('test')
  const hybridCache = new HybridAssignmentCache(localStorageCache, chromeStorageCache)

  beforeEach(() => {
    window.localStorage.clear()
  })

  it('has should return false if cache is empty', async () => {
    const exposureEvent: ExposureEvent = {
      subject: { id: 'subject-1', attributes: {} },
      flag: { key: 'flag-1' },
      allocation: { key: 'allocation-1' },
      variant: { key: 'control' },
    }
    await hybridCache.init()
    expect(hybridCache.has(exposureEvent)).toBeFalsy()
  })

  it('has should return true if cache key is present', async () => {
    const exposureEvent: ExposureEvent = {
      subject: { id: 'subject-1', attributes: {} },
      flag: { key: 'flag-1' },
      allocation: { key: 'allocation-1' },
      variant: { key: 'control' },
    }
    await hybridCache.init()
    expect(hybridCache.has(exposureEvent)).toBeFalsy()
    expect(localStorageCache.has(exposureEvent)).toBeFalsy()
    hybridCache.set(exposureEvent)
    expect(hybridCache.has(exposureEvent)).toBeTruthy()
    expect(localStorageCache.has(exposureEvent)).toBeTruthy()
  })

  it('should populate localStorageCache from chromeStorageCache', async () => {
    const exposureEvent1: ExposureEvent = {
      subject: { id: 'subject-1', attributes: {} },
      flag: { key: 'flag-1' },
      allocation: { key: 'allocation-1' },
      variant: { key: 'control' },
    }
    const exposureEvent2: ExposureEvent = {
      subject: { id: 'subject-2', attributes: {} },
      flag: { key: 'flag-2' },
      allocation: { key: 'allocation-2' },
      variant: { key: 'control' },
    }
    const exposureEvent3: ExposureEvent = {
      subject: { id: 'subject-1', attributes: {} },
      flag: { key: 'flag-1' },
      allocation: { key: 'foo' },
      variant: { key: 'control' },
    }
    expect(localStorageCache.has(exposureEvent1)).toBeFalsy()
    chromeStorageCache.set(exposureEvent1)
    chromeStorageCache.set(exposureEvent2)
    await hybridCache.init()
    expect(localStorageCache.has(exposureEvent1)).toBeTruthy()
    expect(localStorageCache.has(exposureEvent2)).toBeTruthy()
    expect(localStorageCache.has(exposureEvent3)).toBeFalsy()
  })
})
