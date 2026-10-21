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
  await page.route('**/assignments*', async (route) => {
    requests++
    if (offline) return route.fulfill({ status: 503, body: 'offline' })
    const optedOut =
      route.request().postDataJSON().data.attributes.evaluation_options?.experimentation_opt_out_mode === 'immediate'
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
      const requests: { evaluation_options?: { experimentation_opt_out_mode?: string } }[] = []
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
          const optedOut = attributes.evaluation_options?.experimentation_opt_out_mode === 'immediate'
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
        expect(requests[1].evaluation_options?.experimentation_opt_out_mode).toBe(disabled ? undefined : 'immediate')
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

for (const mode of ['online', 'precomputed', 'rules']) {
  test(`${mode}: future policy retains older allocations and checks the precise acknowledgement`, async ({ page }) => {
    const requests: Record<string, unknown>[] = []
    let corruptAcknowledgement = false
    let offline = false
    await page.route('**/intake/**', (route) => route.fulfill({ json: {} }))
    await page.route('**/assignments*', async (route) => {
      if (offline) return route.fulfill({ status: 503, body: 'offline' })
      const attributes = route.request().postDataJSON().data.attributes
      requests.push(attributes)
      const cutoff = attributes.subject.targeting_attributes.dd_experimentation_opt_out_at
      // The mock origin has one allocation activated at ...789. Compare these fixed adjacent test instants.
      const excluded = cutoff === '2026-10-01T12:00:00.123456789Z'
      return route.fulfill({
        json: {
          data: {
            attributes: {
              createdAt: '2026-10-20T00:00:00Z',
              ...(cutoff
                ? {
                    evaluation_options: {
                      experimentation_opt_out_mode: 'future_experiments_only',
                      dd_experimentation_opt_out_at: corruptAcknowledgement ? '2026-10-01T12:00:00.123456788Z' : cutoff,
                    },
                  }
                : {}),
              flags: {
                boolean: {
                  allocationKey: excluded ? 'ordinary' : 'older-experiment',
                  variationKey: 'on',
                  variationType: 'boolean',
                  variationValue: true,
                  doLog: !excluded,
                  reason: 'STATIC',
                },
              },
            },
          },
        },
      })
    })
    await page.goto(`/experimentation-opt-out.html?mode=${mode}&policy=future`)
    await page.waitForFunction(() => '__OPENFEATURE_SMOKE_RESULT__' in globalThis)
    await page.evaluate(() => window.experimentationTest.update('2026-10-01T12:00:00.123456790Z'))
    expect((await page.evaluate(() => window.experimentationTest.evaluate())).flagMetadata?.doLog).toBe(true)
    await page.evaluate(() => window.experimentationTest.update('2026-10-01T12:00:00.123456789Z'))
    expect((await page.evaluate(() => window.experimentationTest.evaluate())).flagMetadata?.doLog).toBe(false)
    if (mode !== 'rules') {
      expect(requests[1].evaluation_options).toEqual({ experimentation_opt_out_mode: 'future_experiments_only' })
      if (mode === 'online') {
        // Wait for the exact future-policy namespace written by the real SDK.
        await page.waitForFunction(async () => {
          for (const { name } of await indexedDB.databases()) {
            if (!name) continue
            const db = await new Promise<IDBDatabase>((resolve) => {
              const request = indexedDB.open(name)
              request.onsuccess = () => resolve(request.result)
            })
            for (const store of db.objectStoreNames) {
              const keys = await new Promise<IDBValidKey[]>((resolve) => {
                const request = db.transaction(store).objectStore(store).getAllKeys()
                request.onsuccess = () => resolve(request.result)
              })
              if (
                keys.some(
                  (key) => String(key).startsWith('future_experiments_only:') && String(key).includes(':123456789-')
                )
              ) {
                db.close()
                return true
              }
            }
            db.close()
          }
          return false
        })
        offline = true
        await page.goto(
          '/experimentation-opt-out.html?mode=online&policy=future&optedOut=true&cutoff=2026-10-01T12:00:00.123456789Z'
        )
        await page.waitForFunction(() => '__OPENFEATURE_SMOKE_RESULT__' in globalThis)
        expect((await page.evaluate(() => window.experimentationTest.evaluate())).flagMetadata?.doLog).toBe(false)
        offline = false
      }
      corruptAcknowledgement = true
      await page.evaluate(() => window.experimentationTest.update('2026-10-01T12:00:00.123456789Z', 'other-subject'))
      expect((await page.evaluate(() => window.experimentationTest.evaluate())).value).toBe(false)
    }
    await page.evaluate(() => window.experimentationTest.close())
  })
}
