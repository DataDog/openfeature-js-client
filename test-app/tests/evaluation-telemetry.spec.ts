import { expect, type Route, test } from '@playwright/test'

declare global {
  interface Window {
    telemetryTest: {
      evaluate(): { value: boolean; repeated: boolean; missing?: string; mismatch?: string }
      update(optedOut: boolean, targetingKey?: string): Promise<void>
      close(): Promise<{ rum: string[]; customerHooks: number }>
    }
    telemetryUpdate: Promise<void>
  }
}

test('online: suppresses evaluation telemetry for opted-out assignments during subject changes', async ({
  page,
}, testInfo) => {
  const evaluations: { evaluation_count: number; targeting_key: string }[] = []
  const exposures: { subject: { id: string } }[] = []
  const errors: string[] = []
  const unexpectedRequests: string[] = []
  let assignmentRequests = 0
  let pendingRequest: Route | undefined
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== 'http://127.0.0.1:4173') {
      unexpectedRequests.push(request.url())
      return route.abort()
    }
    if (url.pathname === '/assignments') {
      assignmentRequests++
      if (assignmentRequests === 2) {
        pendingRequest = route
        return
      }
      const isFirstSubject = request.postDataJSON().data.attributes.subject.targeting_key === 'browser-subject'
      return route.fulfill({
        json: {
          data: {
            attributes: {
              createdAt: '2026-10-14T00:00:00Z',
              flags: {
                'browser-flag': {
                  allocationKey: 'allocation',
                  variationKey: isFirstSubject ? 'on' : 'off',
                  variationType: 'boolean',
                  variationValue: isFirstSubject,
                  reason: 'TARGETING_MATCH',
                  doLog: true,
                },
              },
            },
          },
        },
      })
    }
    if (url.pathname.startsWith('/intake')) {
      const body = request.postData()
      expect(body).not.toBeNull()
      const events = (body || '')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      if (url.pathname.endsWith('/flagevaluation')) evaluations.push(...events)
      else if (url.pathname.endsWith('/exposures')) exposures.push(...events)
      else unexpectedRequests.push(request.url())
      return route.fulfill({ json: {} })
    }
    return route.continue()
  })
  await page.goto('/evaluation-telemetry.html?mode=online&activated=true&optedOut=true')
  await page.waitForFunction(() => '__OPENFEATURE_SMOKE_RESULT__' in globalThis)

  await page.evaluate(() => {
    window.telemetryUpdate = window.telemetryTest.update(false, 'next-subject')
  })
  await expect.poll(() => pendingRequest !== undefined).toBe(true)
  const oldAssignments = { value: true, repeated: true, missing: 'FLAG_NOT_FOUND', mismatch: 'TYPE_MISMATCH' }
  expect(await page.evaluate(() => window.telemetryTest.evaluate())).toEqual(oldAssignments)

  if (!pendingRequest) throw new Error('Expected a pending assignment request')
  await pendingRequest.fulfill({ status: 503, body: 'offline' })
  await page.evaluate(() => window.telemetryUpdate)
  expect(await page.evaluate(() => window.telemetryTest.evaluate())).toEqual(oldAssignments)

  await page.evaluate(() => window.telemetryTest.update(false, 'next-subject'))
  expect(await page.evaluate(() => window.telemetryTest.evaluate())).toEqual({
    ...oldAssignments,
    value: false,
    repeated: false,
  })
  const result = await page.evaluate(() => window.telemetryTest.close())
  await page.waitForLoadState('networkidle')

  expect(evaluations.reduce((total, event) => total + event.evaluation_count, 0)).toBe(4)
  expect(evaluations.every((event) => event.targeting_key === 'next-subject')).toBe(true)
  expect(result.rum).toHaveLength(2)
  expect(result.customerHooks).toBe(12)
  expect(exposures).toHaveLength(2)
  expect(exposures.map((event) => event.subject.id).sort()).toEqual(['browser-subject', 'next-subject'])
  expect(assignmentRequests).toBe(3)
  expect(errors).toEqual([])
  expect(unexpectedRequests).toEqual([])
  await testInfo.attach('subject-change-telemetry', {
    body: JSON.stringify({ evaluations, exposures, rumCallbacks: result.rum, customerHooks: result.customerHooks }),
    contentType: 'application/json',
  })
})

for (const mode of ['online', 'rules', 'precomputed']) {
  for (const multi of [false, true]) {
    for (const scenario of [
      { name: 'disabled', activated: false, values: [true], evaluations: 4, rum: 2 },
      { name: 'opted out', activated: true, values: [true], evaluations: 0, rum: 0 },
      { name: 'context transitions', activated: true, values: [false, true, false], evaluations: 8, rum: 4 },
    ]) {
      test(`${mode}${multi ? ' through MultiProvider' : ''}: counts real uploads for ${scenario.name}`, async ({
        page,
      }) => {
        const assignments: unknown[] = []
        const evaluations: { evaluation_count: number }[] = []
        const exposures: unknown[] = []
        const unexpectedRequests: string[] = []
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.route('**/*', async (route) => {
          const request = route.request()
          const url = new URL(request.url())
          if (url.origin !== 'http://127.0.0.1:4173') {
            unexpectedRequests.push(request.url())
            return route.abort()
          }
          if (url.pathname === '/assignments') {
            assignments.push(request.postDataJSON())
            return route.fulfill({
              json: {
                data: {
                  attributes: {
                    createdAt: '2026-10-14T00:00:00Z',
                    flags: {
                      'browser-flag': {
                        allocationKey: 'allocation',
                        variationKey: 'on',
                        variationType: 'boolean',
                        variationValue: true,
                        reason: 'TARGETING_MATCH',
                        doLog: true,
                      },
                    },
                  },
                },
              },
            })
          }
          if (url.pathname.startsWith('/intake')) {
            const body = request.postData()
            expect(body).not.toBeNull()
            const events = (body || '')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
            if (url.pathname.endsWith('/flagevaluation')) evaluations.push(...events)
            else if (url.pathname.endsWith('/exposures')) exposures.push(...events)
            else unexpectedRequests.push(request.url())
            return route.fulfill({ json: {} })
          }
          return route.continue()
        })
        await page.goto(
          `/evaluation-telemetry.html?mode=${mode}&multi=${multi}&activated=${scenario.activated}&optedOut=${scenario.values[0]}`
        )
        await page.waitForFunction(
          () => '__OPENFEATURE_SMOKE_RESULT__' in globalThis || '__OPENFEATURE_SMOKE_ERROR__' in globalThis
        )
        expect(await page.evaluate(() => Reflect.get(globalThis, '__OPENFEATURE_SMOKE_ERROR__'))).toBeUndefined()
        for (const [index, value] of scenario.values.entries()) {
          if (index > 0) await page.evaluate((value) => window.telemetryTest.update(value), value)
          expect(await page.evaluate(() => window.telemetryTest.evaluate())).toEqual({
            value: true,
            repeated: true,
            // OpenFeature MultiProvider aggregates child failures as GENERAL errors.
            missing: multi ? 'GENERAL' : 'FLAG_NOT_FOUND',
            mismatch: multi ? 'GENERAL' : 'TYPE_MISMATCH',
          })
        }
        const result = await page.evaluate(() => window.telemetryTest.close())
        await page.waitForLoadState('networkidle')
        expect(evaluations.reduce((total, event) => total + event.evaluation_count, 0)).toBe(scenario.evaluations)
        expect(exposures).toHaveLength(new Set(scenario.values).size)
        expect(exposures).toEqual(
          [...new Set(scenario.values)].map((value) =>
            expect.objectContaining({
              subject: expect.objectContaining({
                attributes: expect.objectContaining({ dd_evaluation_telemetry_opt_out: value }),
              }),
            })
          )
        )
        expect(result.rum).toHaveLength(scenario.rum)
        expect(result.customerHooks).toBe(scenario.values.length * 4)
        expect(assignments).toHaveLength(mode === 'rules' ? 0 : scenario.values.length)
        if (mode !== 'rules') expect(JSON.stringify(assignments)).toContain('dd_evaluation_telemetry_opt_out')
        expect(unexpectedRequests).toEqual([])
        expect(errors).toEqual([])
      })
    }
  }
}
