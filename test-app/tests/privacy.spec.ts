import { createHash } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'

declare global {
  interface Window {
    privacyTest: {
      evaluate(): {
        success: { value: boolean }
        missing: { errorCode?: string }
        mismatch: { errorCode?: string }
        hostile: { errorCode?: string }
      }
      refresh(consent: boolean): Promise<void>
      close(): Promise<void>
    }
  }
}
interface Event {
  targeting_key?: string
  flag: { key: string }
  evaluation_count: number
  error?: { message: string }
  context?: { evaluation?: unknown; dd?: { service?: string } }
}
const hash = 'sha256_b4698f9b6d186781fa8dc59e533578fa2d8379a46b1cf6db85cda6aa9c99e51b'
async function capture(page: Page, initial: unknown, failFirst = false) {
  let consent = initial
  const events: Event[] = []
  const requests: string[] = []
  const assignments: unknown[] = []
  const errors: string[] = []
  let intakeAttempts = 0
  page.on('pageerror', (error) => errors.push(error.message))
  // Observe outgoing bodies independently of route handling, including unload beacons.
  page.context().on('request', (request) => {
    if (!new URL(request.url()).pathname.endsWith('/flagevaluation')) return
    const body = request.postData() || ''
    requests.push(body)
    events.push(
      ...body
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    )
  })
  await page.context().route('**/*', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== 'http://127.0.0.1:4173') {
      errors.push(`unexpected request ${url.pathname}`)
      return route.abort()
    }
    if (url.pathname === '/assignments') {
      assignments.push(request.postDataJSON())
      return route.fulfill({
        json: {
          data: {
            attributes: {
              createdAt: '2026-10-21T00:00:00Z',
              ...(consent === undefined ? {} : { observeFullEvaluationData: consent }),
              flags: {
                'browser-flag': {
                  allocationKey: 'allocation',
                  variationKey: 'on',
                  variationType: 'boolean',
                  variationValue: true,
                  reason: 'STATIC',
                  doLog: false,
                },
              },
            },
          },
        },
      })
    }
    if (url.pathname.endsWith('/flagevaluation')) {
      intakeAttempts++
      return route.fulfill({ status: failFirst && intakeAttempts === 1 ? 503 : 200, json: {} })
    }
    return route.continue()
  })
  return {
    events,
    requests,
    assignments,
    errors,
    setConsent: (next: unknown) => {
      consent = next
    },
  }
}
async function ready(page: Page, query: string) {
  await page.goto(`/privacy.html?${query}`)
  await page.waitForFunction(
    () => '__OPENFEATURE_SMOKE_RESULT__' in globalThis || '__OPENFEATURE_SMOKE_ERROR__' in globalThis
  )
  expect(await page.evaluate(() => Reflect.get(globalThis, '__OPENFEATURE_SMOKE_ERROR__'))).toBeUndefined()
}
async function evaluate(page: Page) {
  const result = await page.evaluate(() => window.privacyTest.evaluate())
  expect(result.success.value).toBe(true)
  expect(result.missing.errorCode).toBe('FLAG_NOT_FOUND')
  expect(result.mismatch.errorCode).toBe('TYPE_MISMATCH')
}

for (const mode of ['online', 'precomputed', 'rules']) {
  for (const initial of [true, false]) {
    test(`${mode}: retains evaluation-time consent across ${initial} -> ${!initial} refresh and shutdown`, async ({
      page,
    }, testInfo) => {
      const captured = await capture(page, initial)
      await ready(page, `mode=${mode}&consent=${initial}`)
      await evaluate(page)
      captured.setConsent(!initial)
      await page.evaluate((consent) => window.privacyTest.refresh(consent), !initial)
      await evaluate(page)
      await page.evaluate(() => window.privacyTest.close())
      await expect.poll(() => captured.events.reduce((sum, event) => sum + event.evaluation_count, 0)).toBe(8)
      const full = captured.events.filter((event) => event.targeting_key === 'jane.doe@datadoghq.com')
      const protectedEvents = captured.events.filter((event) => event.targeting_key === hash)
      // Failures in a customer before-hook have no evaluated consent and stay protected.
      expect(full.reduce((sum, event) => sum + event.evaluation_count, 0)).toBe(3)
      expect(protectedEvents.reduce((sum, event) => sum + event.evaluation_count, 0)).toBe(5)
      expect(protectedEvents.every((event) => event.context?.evaluation === undefined)).toBe(true)
      expect(JSON.stringify(protectedEvents)).not.toContain('canary')
      expect(JSON.stringify(full)).toContain('context-canary@example.com')
      expect(captured.events.every((event) => event.context?.dd?.service === 'privacy-test-service')).toBe(true)
      expect(
        captured.events
          .filter((event) => event.error)
          .map((event) => event.error!.message)
          .sort()
      ).toEqual(['FLAG_NOT_FOUND', 'FLAG_NOT_FOUND', 'GENERAL', 'TYPE_MISMATCH', 'TYPE_MISMATCH'].sort())
      if (mode !== 'rules') expect(JSON.stringify(captured.assignments)).toContain('context-canary@example.com')
      expect(captured.errors).toEqual([])
      await testInfo.attach('evaluation-wire', {
        body: JSON.stringify(captured.events),
        contentType: 'application/json',
      })
    })
  }
}
for (const consent of [undefined, null, 'true', 1]) {
  test(`online: protects malformed/legacy consent ${consent} on page exit`, async ({ page }) => {
    const captured = await capture(page, consent)
    await ready(page, 'mode=online')
    await evaluate(page)
    // Browser-core ignores synthetic lifecycle events unless its test trust marker is set.
    await page.evaluate(() => window.dispatchEvent(Object.assign(new Event('beforeunload'), { __ddIsTrusted: true })))
    await expect.poll(() => captured.events.reduce((sum, event) => sum + event.evaluation_count, 0)).toBe(4)
    expect(
      captured.events.every((event) => event.targeting_key === hash && event.context?.evaluation === undefined)
    ).toBe(true)
    expect(JSON.stringify(captured.events)).not.toContain('canary')
    expect(captured.errors).toEqual([])
  })
}
test('tracking disable wins even with full-data consent', async ({ page }) => {
  const captured = await capture(page, true)
  await ready(page, 'mode=online&tracking=false')
  await evaluate(page)
  await page.evaluate(() => window.privacyTest.close())
  await page.waitForLoadState('networkidle')
  expect(captured.events).toEqual([])
  expect(captured.errors).toEqual([])
})

for (const key of ['', '\ud800', 'café', 'cafe\u0301', '🚲/旗']) {
  test(`strict Unicode without native encoders or Web Crypto: ${JSON.stringify(key)}`, async ({ page }) => {
    const captured = await capture(page, false)
    await page.addInitScript((key) => {
      Reflect.set(globalThis, 'privacyTargetingKey', key)
      Object.defineProperty(globalThis, 'TextEncoder', { value: undefined, configurable: true })
      Object.defineProperty(globalThis, 'TextDecoder', { value: undefined, configurable: true })
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
    }, key)
    await ready(page, 'mode=online')
    await evaluate(page)
    await page.evaluate(() => window.privacyTest.close())
    await expect.poll(() => captured.events.reduce((sum, event) => sum + event.evaluation_count, 0)).toBe(4)
    const expected =
      key === '\ud800' ? undefined : key === '' ? '' : `sha256_${createHash('sha256').update(key).digest('hex')}`
    expect(captured.events.every((event) => event.targeting_key === expected)).toBe(true)
    expect(captured.events.every((event) => event.context?.evaluation === undefined)).toBe(true)
    expect(captured.errors).toEqual([])
  })
}

test('retries the same protected payload after consent refresh', async ({ page }) => {
  await page.clock.install()
  const captured = await capture(page, false, true)
  await ready(page, 'mode=online&interval=1000')
  await evaluate(page)
  await page.clock.runFor(31_000)
  await expect.poll(() => captured.requests.length).toBe(1)
  captured.setConsent(true)
  await page.evaluate(() => window.privacyTest.refresh(true))
  await page.clock.runFor(2_000)
  await expect.poll(() => captured.requests.length).toBe(2)
  expect(captured.requests[1]).toBe(captured.requests[0])
  expect(
    captured.events.every((event) => event.targeting_key === hash && event.context?.evaluation === undefined)
  ).toBe(true)
  expect(JSON.stringify(captured.events)).not.toContain('canary')
  expect(captured.errors).toEqual([])
  await page.evaluate(() => window.privacyTest.close())
})
