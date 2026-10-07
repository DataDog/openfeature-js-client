import type { ExposureEvent } from '@datadog/flagging-core'
import { assignmentCacheFactory } from '../../src/cache/assignment-cache-factory'
import { createExposureCache } from '../../src/cache/exposure-cache'
import { withStore } from '../../src/cache/indexeddb-store'
import { validateAndBuildFlaggingTrackingConfiguration } from '../../src/domain/configuration'
import { nextWrite } from './indexeddb-test-helpers'

const exposure: ExposureEvent = {
  flag: { key: 'flag' },
  subject: { id: 'user', attributes: {} },
  allocation: { key: 'allocation' },
  variant: { key: 'variant' },
}

describe('exposure cache storage boundaries', () => {
  it('clears only its own namespace and leaves configuration snapshots intact', async () => {
    const createCache = (storageKeySuffix: string) => assignmentCacheFactory({ storageKeySuffix })
    await withStore('readwrite', (store) => store.put('preserve', 'v2-flags-config-other'))
    for (const scope of ['scope-a', 'scope-b']) {
      const cache = createCache(scope)
      await cache.init()
      const written = nextWrite()
      cache.set(exposure)
      await written
    }
    await createCache('scope-a').clear()
    const first = createCache('scope-a')
    const second = createCache('scope-b')
    await Promise.all([first.init(), second.init()])
    expect(first.has(exposure)).toBe(false)
    expect(second.has(exposure)).toBe(true)
    expect(await withStore('readonly', (store) => store.getAllKeys())).toEqual([
      'assignments-scope-b',
      'v2-flags-config-other',
    ])
  })

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
    expect(proxy).not.toHaveBeenCalled()
  })
})
