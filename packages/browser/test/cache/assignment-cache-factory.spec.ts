/**
 * @jest-environment jsdom
 */

import type { ExposureEvent } from '../../../core/src/configuration/exposureEvent.types'
import { assignmentCacheFactory } from '../../src/cache/assignment-cache-factory'
import HybridAssignmentCache from '../../src/cache/hybrid-assignment-cache'

import StorageArea = chrome.storage.StorageArea

describe('AssignmentCacheFactory', () => {
  // TODO: Extract test-only function for this
  const fakeStore: { [k: string]: string } = {}

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

  beforeEach(() => {
    window.localStorage.clear()
    Object.keys(fakeStore).forEach((key) => delete fakeStore[key])
  })

  it('should create a hybrid cache if chrome storage is available', () => {
    const cache = assignmentCacheFactory({
      chromeStorage: mockChromeStorage,
      storageKeySuffix: 'foo',
    })
    expect(cache).toBeInstanceOf(HybridAssignmentCache)
    expect(Object.keys(fakeStore)).toHaveLength(0)
    const exposureEvent: ExposureEvent = {
      subject: { id: 'foo', attributes: {} },
      flag: { key: 'bar' },
      allocation: { key: 'baz' },
      variant: { key: 'qux' },
    }
    cache.set(exposureEvent)
    expect(Object.keys(fakeStore)).toHaveLength(1)
  })

  it('should create a hybrid cache if local storage is available', () => {
    const cache = assignmentCacheFactory({
      storageKeySuffix: 'foo',
    })
    expect(cache).toBeInstanceOf(HybridAssignmentCache)
    expect(localStorage.length).toEqual(0)
    const exposureEvent: ExposureEvent = {
      subject: { id: 'foo', attributes: {} },
      flag: { key: 'bar' },
      allocation: { key: 'baz' },
      variant: { key: 'qux' },
    }
    cache.set(exposureEvent)
    // chrome storage is not being used
    expect(Object.keys(fakeStore)).toHaveLength(0)
    // local storage is being used
    expect(localStorage.length).toEqual(1)
  })
})
