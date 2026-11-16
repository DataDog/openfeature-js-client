import { expect, test } from '@playwright/test'

for (const debugMode of [false, true]) {
  test(`packed browser provider preserves evaluation and delivery with debugMode=${debugMode}`, async ({ page }) => {
    const logs: { event: string; details: Record<string, unknown> }[] = []
    const errors: string[] = []
    const uploads: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      const prefix = '[Datadog Feature Flags] '
      if (message.text().startsWith(prefix)) logs.push(JSON.parse(message.text().slice(prefix.length)))
    })
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== 'http://127.0.0.1:4173') return route.abort()
      if (url.pathname === '/assignments') {
        return route.fulfill({
          json: {
            data: {
              attributes: {
                createdAt: '2026-11-02T00:00:00Z',
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
        uploads.push(route.request().postData() ?? '')
        return route.fulfill({ status: 202, json: { accepted: true } })
      }
      return route.continue()
    })
    await page.goto(`/evaluation-telemetry.html?mode=online&debugMode=${debugMode}`)
    await page.waitForFunction(
      () => '__OPENFEATURE_SMOKE_RESULT__' in globalThis || '__OPENFEATURE_SMOKE_ERROR__' in globalThis
    )
    expect(await page.evaluate(() => Reflect.get(globalThis, '__OPENFEATURE_SMOKE_ERROR__'))).toBeUndefined()
    expect(await page.evaluate(() => window.telemetryTest.evaluate())).toEqual({
      value: true,
      repeated: true,
      missing: 'FLAG_NOT_FOUND',
      mismatch: 'TYPE_MISMATCH',
    })
    // Closing flushes the existing aggregation and batch queues without waiting for their 30-second timer.
    await page.evaluate(() => window.telemetryTest.close())
    await expect.poll(() => uploads.length).toBeGreaterThan(0)
    if (debugMode) {
      await expect.poll(() => logs.some(({ event }) => event === 'upload.completed')).toBe(true)
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'debug.enabled' }),
          expect.objectContaining({
            event: 'context.normalized',
            details: expect.objectContaining({
              rawContext: expect.objectContaining({ targetingKey: 'browser-subject', country: 'US' }),
              normalizedContext: expect.objectContaining({ country: 'US' }),
            }),
          }),
          expect.objectContaining({
            event: 'evaluation.completed',
            details: expect.objectContaining({
              defaultValue: false,
              runtimeDefaultUsed: false,
              result: expect.objectContaining({ value: true, variant: 'on' }),
            }),
          }),
          expect.objectContaining({
            event: 'upload.completed',
            details: expect.objectContaining({
              httpStatus: 202,
              outcome: 'intake_accepted',
            }),
          }),
        ])
      )
      expect(JSON.stringify(logs)).not.toContain('local-telemetry-test')
    } else {
      expect(logs).toEqual([])
    }
    expect(errors).toEqual([])
  })
}
