import { expect, type Page, test } from '@playwright/test'

type SmokeResult = Record<string, unknown>

async function runSmoke(page: Page, path: string): Promise<SmokeResult> {
  const runtimeErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console.error: ${message.text()}`)
  })
  page.on('pageerror', (error) => runtimeErrors.push(`page error: ${error.message}`))

  await page.goto(path)

  expect(runtimeErrors).toEqual([])
  const result = await page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __OPENFEATURE_SMOKE_RESULT__?: SmokeResult
        }
      ).__OPENFEATURE_SMOKE_RESULT__
  )
  expect(result).toBeDefined()
  return result!
}

test('decodes and evaluates packed protobuf rules in Chromium', async ({ page }) => {
  const result = await runSmoke(page, '/')

  expect(result).toEqual({
    entrypoint: 'protobuf',
    protobufTypeName: 'datadog.ffe.flagging.ufc.v1.FlagsConfiguration',
    booleanValue: true,
    integerValue: 42,
    providerValue: true,
  })
})

test('decodes protobuf without native text or bigint globals', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(globalThis, {
      BigInt: undefined,
      TextDecoder: undefined,
      TextEncoder: undefined,
    })
  })

  const result = await runSmoke(page, '/')
  expect(result.protobufTypeName).toBe('datadog.ffe.flagging.ufc.v1.FlagsConfiguration')
  expect(result.booleanValue).toBe(true)
  expect(result.integerValue).toBe(42)
  expect(result.providerValue).toBe(true)
})

test('executes the packed precomputed entrypoint in Chromium', async ({ page }) => {
  const result = await runSmoke(page, '/precomputed.html')

  expect(result).toEqual({
    entrypoint: 'precomputed',
    booleanValue: true,
    rulesExcluded: true,
  })
})
