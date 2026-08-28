import { expect, test } from '@playwright/test'

test('retries a packed Request body without retrying caller cancellation', async ({ page }) => {
  const runtimeErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console.error: ${message.text()}`)
  })
  page.on('pageerror', (error) => runtimeErrors.push(`page error: ${error.message}`))

  await page.goto('/')
  await page.waitForFunction(() => '__OPENFEATURE_SMOKE_RESULT__' in globalThis)

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
    attempts: 2,
    bodies: ['configuration request', 'configuration request'],
    cancellationAttempts: 1,
  })
})
