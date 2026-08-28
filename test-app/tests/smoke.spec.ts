import { expect, test } from '@playwright/test'
import type { SmokeResult } from '../src/smokeResult'

type SmokeState = {
  error?: string
  result?: SmokeResult
}

test('runs the packed provider and Fetch wrapper smoke coverage', async ({ page }) => {
  const runtimeErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console.error: ${message.text()}`)
  })
  page.on('pageerror', (error) => runtimeErrors.push(`page error: ${error.message}`))

  await page.goto('/')
  await page.waitForFunction(
    () => '__OPENFEATURE_SMOKE_RESULT__' in globalThis || '__OPENFEATURE_SMOKE_ERROR__' in globalThis
  )

  const state = await page.evaluate(() => {
    const smokeGlobal = globalThis as typeof globalThis & {
      __OPENFEATURE_SMOKE_ERROR__?: string
      __OPENFEATURE_SMOKE_RESULT__?: SmokeState['result']
    }
    return {
      error: smokeGlobal.__OPENFEATURE_SMOKE_ERROR__,
      result: smokeGlobal.__OPENFEATURE_SMOKE_RESULT__,
    } satisfies SmokeState
  })

  expect(state.error).toBeUndefined()
  expect(runtimeErrors).toEqual([])
  expect(state.result).toEqual({
    provider: {
      value: true,
      reason: 'TARGETING_MATCH',
      variant: 'variation-packed-browser',
      attempts: 1,
    },
    timeout: {
      errorName: 'TimeoutError',
    },
    retry: {
      attempts: 2,
      bodies: ['configuration request', 'configuration request'],
    },
    cancellation: {
      errorName: 'AbortError',
      attempts: 1,
    },
  })
})
