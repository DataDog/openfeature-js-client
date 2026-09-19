import type { ExposureEvent } from '@datadog/flagging-core'
import { assignmentCacheFactory } from '../../src/cache/assignment-cache-factory'
import { createExposureCache } from '../../src/cache/exposure-cache'
import { validateAndBuildFlaggingTrackingConfiguration } from '../../src/domain/configuration'

const exposure: ExposureEvent = {
  flag: { key: 'flag' },
  subject: { id: 'user', attributes: {} },
  allocation: { key: 'allocation' },
  variant: { key: 'variant' },
}

describe('exposure cache storage boundaries', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it.each(['localStorage', 'chrome'] as const)(
    'clears only its own %s namespace, including persisted entries',
    async (kind) => {
      const stored: Record<string, string> = { unrelated: 'preserve-me' }
      const storage = {
        get: jest.fn(async () => ({ ...stored })),
        set: jest.fn(async (entries: Record<string, string>) => {
          Object.assign(stored, entries)
        }),
        remove: jest.fn(async (keys: string[]) => {
          for (const key of keys) delete stored[key]
        }),
        clear: jest.fn(),
      } as unknown as chrome.storage.StorageArea
      const createCache = (storageKeySuffix: string) =>
        assignmentCacheFactory({
          storageKeySuffix,
          chromeStorage: kind === 'chrome' ? storage : undefined,
        })
      const first = createCache('scope-a')
      const second = createCache('scope-b')
      first.set(exposure)
      second.set(exposure)
      await first.clear()

      const reloadedFirst = createCache('scope-a')
      const reloadedSecond = createCache('scope-b')
      await Promise.all([reloadedFirst.init(), reloadedSecond.init()])
      expect(reloadedFirst.has(exposure)).toBe(false)
      expect(reloadedSecond.has(exposure)).toBe(true)
      expect(stored.unrelated).toBe('preserve-me')
      expect(storage.clear).not.toHaveBeenCalled()
    }
  )

  it('keeps callback proxy caches independent without invoking the proxy during setup', async () => {
    const proxy = jest.fn(() => 'https://proxy.example.com/intake')
    const options = { clientToken: 'token', proxy }
    const configuration = validateAndBuildFlaggingTrackingConfiguration(options)!
    const first = createExposureCache(options, configuration)
    await first.init()
    first.set(exposure)

    const second = createExposureCache(options, configuration)
    await second.init()
    expect(first.has(exposure)).toBe(true)
    expect(second.has(exposure)).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(proxy).not.toHaveBeenCalled()
  })
})
