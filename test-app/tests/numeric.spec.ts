import { expect, test } from '@playwright/test'

for (const variationType of ['number', 'integer', 'float']) {
  for (const [token, valid] of [
    ['9007199254740993', false],
    ['1e-999', false],
    ['1e999', false],
    ['9007199254740994', true],
    ['1.20000000000000001', true],
  ] as const) {
    test(`${variationType} JSON token ${token}`, async ({ page }) => {
      // Fulfill with bytes, not a JS object that has already lost the token.
      const body = `{"data":{"attributes":{"createdAt":"2026-11-23T00:00:00Z","flags":{"probe":{"allocationKey":"allocation","variationKey":"variant","variationType":"${variationType}","variationValue":${token},"reason":"TARGETING_MATCH","doLog":false}}}}}`
      await page.route(/\/assignments(?:\?|$)/, (route) => route.fulfill({ body, contentType: 'application/json' }))
      await page.goto('/numeric.html')
      await page.waitForFunction(
        () => '__OPENFEATURE_SMOKE_RESULT__' in globalThis || '__OPENFEATURE_SMOKE_ERROR__' in globalThis
      )
      expect(await page.evaluate(() => Reflect.get(globalThis, '__OPENFEATURE_SMOKE_ERROR__'))).toBeUndefined()
      const result = await page.evaluate(() => Reflect.get(globalThis, '__OPENFEATURE_SMOKE_RESULT__'))
      for (const details of [result.core, result.browser]) {
        expect(details).toMatchObject(
          valid
            ? { value: Number(token), reason: 'TARGETING_MATCH', variant: 'variant' }
            : { value: -99.5, reason: 'ERROR', errorCode: 'TYPE_MISMATCH' }
        )
        if (!valid) expect(details.variant).toBeUndefined()
      }
    })
  }
}
