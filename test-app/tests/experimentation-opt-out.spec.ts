import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    experimentationTest: {
      evaluate(): { value: boolean; errorCode?: string; flagMetadata?: { allocationKey?: string; doLog?: boolean } }
      allTypes(): unknown[]
      update(value?: unknown, targetingKey?: string): Promise<void>
      close(): Promise<void>
    }
    experimentationUpdate: Promise<void>
  }
}

test('online: reload uses only acknowledged opted-out assignments from IndexedDB', async ({ page }) => {
  let offline = false
  let requests = 0
  await page.route('**/assignments?*', async (route) => {
    requests++
    if (offline) return route.fulfill({ status: 503, body: 'offline' })
    const optedOut = route.request().postDataJSON().data.attributes.evaluation_options?.experimentation_opt_out === true
    return route.fulfill({
      json: {
        data: {
          attributes: {
            createdAt: '2026-10-19T12:00:00Z',
            ...(optedOut ? { evaluation_options: { experimentation_opt_out: true } } : {}),
            flags: {
              boolean: {
                allocationKey: optedOut ? 'fallback' : 'experiment',
                variationKey: 'on',
                variationType: 'boolean',
                variationValue: true,
                reason: 'TARGETING_MATCH',
                doLog: !optedOut,
              },
            },
          },
        },
      },
    })
  })
  await page.route('**/intake/**', (route) => route.fulfill({ json: {} }))
  await page.goto('/experimentation-opt-out.html?mode=online&optedOut=true&disabled=true')
  await page.waitForFunction(() => '__OPENFEATURE_SMOKE_RESULT__' in globalThis)
  expect((await page.evaluate(() => window.experimentationTest.evaluate())).flagMetadata?.doLog).toBe(true)
  // A mode change must not reuse the eligible snapshot, even when its context contains the same timestamp.
  offline = true
  await page.goto('/experimentation-opt-out.html?mode=online&optedOut=true')
  await page.waitForFunction(() => '__OPENFEATURE_SMOKE_ERROR__' in globalThis)
  offline = false
  await page.reload()
  await page.waitForFunction(() => '__OPENFEATURE_SMOKE_RESULT__' in globalThis)
  expect((await page.evaluate(() => window.experimentationTest.evaluate())).flagMetadata?.doLog).toBe(false)
  // Wait for the SDK's actual IndexedDB transaction, not a timer.
  await page.waitForFunction(async () => {
    const databases = await indexedDB.databases()
    for (const database of databases) {
      if (!database.name) continue
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database.name!)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      for (const name of db.objectStoreNames) {
        const keys = await new Promise<IDBValidKey[]>((resolve) => {
          const request = db.transaction(name).objectStore(name).getAllKeys()
          request.onsuccess = () => resolve(request.result)
        })
        if (keys.some((key) => String(key).startsWith('opted-out-flags-config-'))) {
          db.close()
          return true
        }
      }
      db.close()
    }
    return false
  })
  offline = true
  await page.reload()
  await page.waitForFunction(() => '__OPENFEATURE_SMOKE_RESULT__' in globalThis)
  expect((await page.evaluate(() => window.experimentationTest.evaluate())).flagMetadata?.doLog).toBe(false)
  expect(requests).toBe(4)
  await page.evaluate(() => window.experimentationTest.close())
})

for (const mode of ['online', 'precomputed', 'rules']) {
  for (const disabled of [false, true]) {
    test(`${mode}: opted-out subjects, ordinary fallback, telemetry unchanged; disabled=${disabled}`, async ({
      page,
    }) => {
      const requests: { evaluation_options?: { experimentation_opt_out?: boolean } }[] = []
      const evaluations: { evaluation_count: number }[] = []
      const exposures: unknown[] = []
      const errors: string[] = []
      let acknowledge = true
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.origin !== 'http://127.0.0.1:4173') throw new Error(`Unexpected network request: ${url.origin}`)
        if (url.pathname === '/assignments') {
          const attributes = route.request().postDataJSON().data.attributes
          requests.push(attributes)
          const optedOut = attributes.evaluation_options?.experimentation_opt_out === true
          const flags = Object.fromEntries(
            [
              ['boolean', true],
              ['string', 'ordinary'],
              ['number', 42],
              ['object', { ordinary: true }],
            ].map(([type, value]) => [
              String(type),
              {
                allocationKey: optedOut ? 'fallback' : 'experiment',
                variationKey: 'on',
                variationType: type,
                variationValue: value,
                reason: 'TARGETING_MATCH',
                doLog: !optedOut,
              },
            ])
          )
          return route.fulfill({
            json: {
              data: {
                attributes: {
                  createdAt: '2026-10-19T12:00:00Z',
                  flags,
                  ...(optedOut && acknowledge ? { evaluation_options: { experimentation_opt_out: true } } : {}),
                },
              },
            },
          })
        }
        if (url.pathname.startsWith('/intake')) {
          const events = route
            .request()
            .postData()!
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
          if (url.pathname.endsWith('/flagevaluation')) evaluations.push(...events)
          else if (url.pathname.endsWith('/exposures')) exposures.push(...events)
          return route.fulfill({ json: {} })
        }
        return route.continue()
      })
      await page.goto(`/experimentation-opt-out.html?mode=${mode}&disabled=${disabled}`)
      await page.waitForFunction(
        () => '__OPENFEATURE_SMOKE_RESULT__' in globalThis || '__OPENFEATURE_SMOKE_ERROR__' in globalThis
      )
      expect(await page.evaluate(() => Reflect.get(globalThis, '__OPENFEATURE_SMOKE_ERROR__'))).toBeUndefined()
      expect((await page.evaluate(() => window.experimentationTest.evaluate())).flagMetadata?.doLog).toBe(true)
      await page.evaluate(() => window.experimentationTest.update('2099-01-01T00:00:00Z'))
      const optedOut = await page.evaluate(() => window.experimentationTest.evaluate())
      expect(optedOut.value).toBe(true)
      expect(optedOut.flagMetadata?.doLog).toBe(disabled)
      if (!disabled) expect(optedOut.flagMetadata?.allocationKey).toBe('fallback')
      if (mode !== 'rules') {
        expect(await page.evaluate(() => window.experimentationTest.allTypes())).toEqual([
          true,
          'ordinary',
          42,
          { ordinary: true },
        ])
        expect(requests[1].evaluation_options?.experimentation_opt_out).toBe(disabled ? undefined : true)
      }
      if (!disabled) {
        acknowledge = false
        await page.evaluate(() => window.experimentationTest.update('2026-10-20T00:00:00Z', 'other-subject'))
        const missingAck = await page.evaluate(() => window.experimentationTest.evaluate())
        expect(missingAck.value).toBe(mode === 'rules')
        const beforeInvalid = requests.length
        await page.evaluate(() => window.experimentationTest.update(true))
        expect((await page.evaluate(() => window.experimentationTest.evaluate())).value).toBe(false)
        expect(requests).toHaveLength(beforeInvalid)
      }
      await page.evaluate(() => window.experimentationTest.close())
      await page.waitForLoadState('networkidle')
      expect(evaluations.reduce((sum, e) => sum + e.evaluation_count, 0)).toBeGreaterThanOrEqual(2)
      expect(exposures.length).toBe(disabled ? (mode === 'rules' ? 2 : 5) : 1)
      expect(errors).toEqual([])
    })
  }
}
