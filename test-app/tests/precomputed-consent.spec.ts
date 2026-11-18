import { expect, test } from '@playwright/test'
import fixtures from './fixtures/edge-consent.json' with { type: 'json' }

for (const fixture of fixtures) {
  const { consent, optimized, streaming, obfuscated, response } = fixture
  test(`backend consent ${consent}, optimized ${optimized}, streaming ${streaming}, obfuscated ${obfuscated}`, async ({
    page,
  }) => {
    await page.route(/\/assignments(?:\?|$)/, (route) => route.fulfill({ json: response }))
    await page.goto('/consent.html')
    await page.waitForFunction(
      () => '__OPENFEATURE_SMOKE_RESULT__' in globalThis || '__OPENFEATURE_SMOKE_ERROR__' in globalThis
    )
    expect(await page.evaluate(() => Reflect.get(globalThis, '__OPENFEATURE_SMOKE_ERROR__'))).toBeUndefined()
    const result = await page.evaluate(() => Reflect.get(globalThis, '__OPENFEATURE_SMOKE_RESULT__'))
    const metadata = { __dd_observe_full_evaluation_data: consent, __dd_eval_timestamp_ms: expect.any(Number) }
    for (const details of [result.core, result.browser]) {
      expect(details).toMatchObject({ value: 'hello-us', variant: 'us', flagMetadata: { ...metadata, doLog: false } })
    }
    expect(result.missing).toMatchObject({ value: 'fallback', errorCode: 'FLAG_NOT_FOUND', flagMetadata: metadata })
    expect(result.mismatch).toMatchObject({ value: false, errorCode: 'TYPE_MISMATCH', flagMetadata: metadata })
  })
}
