import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    telemetryTest: {
      evaluate(): { value: boolean; repeated: boolean; missing?: string; mismatch?: string }
      update(optedOut: boolean): Promise<void>
      close(): Promise<{ rum: string[]; customerHooks: number }>
    }
  }
}

for (const mode of ['online', 'rules', 'precomputed']) {
  for (const scenario of [
    { name: 'disabled', activated: false, values: [true], evaluations: 4, rum: 2 },
    { name: 'opted out', activated: true, values: [true], evaluations: 0, rum: 0 },
    { name: 'context transitions', activated: true, values: [false, true, false], evaluations: 8, rum: 4 },
  ]) {
    test(`${mode}: counts real uploads for ${scenario.name}`, async ({ page }) => {
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
        `/evaluation-telemetry.html?mode=${mode}&activated=${scenario.activated}&optedOut=${scenario.values[0]}`
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
          missing: 'FLAG_NOT_FOUND',
          mismatch: 'TYPE_MISMATCH',
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
