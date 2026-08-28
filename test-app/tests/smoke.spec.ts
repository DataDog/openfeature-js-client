import { expect, test } from '@playwright/test'

test('enforces packed Fetch timeout and retry behavior', async ({ page }) => {
  const runtimeErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console.error: ${message.text()}`)
  })
  page.on('pageerror', (error) => runtimeErrors.push(`page error: ${error.message}`))

  await page.goto('/')
  await page.waitForFunction(
    () => '__OPENFEATURE_SMOKE_RESULT__' in globalThis || '__OPENFEATURE_SMOKE_ERROR__' in globalThis
  )

  const smokeError = await page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __OPENFEATURE_SMOKE_ERROR__?: string
        }
      ).__OPENFEATURE_SMOKE_ERROR__
  )
  expect(smokeError).toBeUndefined()

  expect(runtimeErrors).toEqual([])
  const result = await page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __OPENFEATURE_SMOKE_RESULT__?: Record<string, unknown>
        }
      ).__OPENFEATURE_SMOKE_RESULT__
  )
  expect(result).toEqual({
    timeoutErrorName: 'TimeoutError',
    attempts: 2,
    bodies: ['configuration request', 'configuration request'],
    cancellationErrorName: 'AbortError',
    cancellationAttempts: 1,
  })
})
