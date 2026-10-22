import { expect, test } from '@playwright/test'
import precomputedResponse from '../../packages/browser/test/data/precomputed-v1.json' with { type: 'json' }

for (const scenario of ['success', 'failure'] as const) {
  test(`real provider sends diagnostic-only ${scenario} records without RUM`, async ({ page }) => {
    const diagnosticLogs: string[] = []
    page.on('console', (message) => {
      if (message.text().includes('[Datadog Feature Flags]')) diagnosticLogs.push(message.text())
    })
    const records: {
      type: string
      schema_version: number
      payload: {
        event_type: string
        runtime_id: string
        initialization?: { outcome: string; final: boolean }
        error_code?: string
      }
    }[] = []
    await page.route('**/precompute-assignments**', (route) => route.fulfill({ json: precomputedResponse }))
    await page.route('https://browser-intake-datad0g.com/**', async (route) => {
      expect(new URL(route.request().url()).pathname).toBe('/api/v2/flagevaluation')
      expect(route.request().headers()['content-type']).toMatch(/^text\/plain(?:;|$)/)
      for (const line of (route.request().postData() ?? '').split('\n').filter(Boolean)) records.push(JSON.parse(line))
      await route.fulfill({ status: 202, body: '' })
    })
    await page.goto('/diagnostics.html')
    await page.getByLabel('Enable debugMode', { exact: false }).uncheck()
    await page.getByLabel('Staging client token').fill('test-client-token')
    await page.getByLabel('Application ID').fill('test-app')
    await page.getByLabel('Configuration request').selectOption(scenario)
    await page.getByRole('button', { name: 'Initialize provider' }).click()
    await expect(page.locator('#status')).toContainText(
      scenario === 'success' ? 'Initialization completed' : 'Initialization failed'
    )
    await page.getByRole('button', { name: 'Flush diagnostics and close provider' }).click()
    await expect.poll(() => records.length).toBe(1)
    expect(records[0].payload).toMatchObject({
      event_type: 'sdk_initialization',
      initialization: { outcome: scenario === 'success' ? 'ready' : 'failed', final: true },
    })
    expect(records[0].payload.error_code).toBe(scenario === 'success' ? undefined : 'INIT_FAILED')
    expect(new Set(records.map((record) => record.payload.runtime_id)).size).toBe(1)
    expect(records.every((record) => record.type === 'sdk_diagnostic' && record.schema_version === 1)).toBe(true)
    expect(JSON.stringify(records)).not.toContain('test-client-token')
    expect(JSON.stringify(records)).not.toContain('evaluation_count')
    expect(diagnosticLogs).toEqual([])
  })
}

for (const debugMode of [false, true]) {
  test(`blocked telemetry preserves flag evaluation with debugMode=${debugMode}`, async ({ page }) => {
    const attemptedEvents: string[] = []
    await page.clock.install()
    await page.route('**/precompute-assignments**', (route) => route.fulfill({ json: precomputedResponse }))
    await page.route('https://browser-intake-datad0g.com/**', async (route) => {
      expect(new URL(route.request().url()).pathname).toBe('/api/v2/flagevaluation')
      expect(route.request().headers()['content-type']).toMatch(/^text\/plain(?:;|$)/)
      for (const line of (route.request().postData() ?? '').split('\n').filter(Boolean)) {
        attemptedEvents.push(JSON.parse(line).payload.event_type)
      }
      await route.abort()
    })
    await page.goto('/diagnostics.html')
    await page.getByLabel('Enable debugMode', { exact: false }).setChecked(debugMode)
    await page.getByLabel('Staging client token').fill('test-client-token')
    await page.getByLabel('Application ID').fill('test-app')
    await page.getByRole('button', { name: 'Initialize provider' }).click()
    await expect(page.locator('#status')).toContainText('Initialization completed')

    const failedUpload = page.waitForEvent('requestfailed', (request) =>
      request.url().startsWith('https://browser-intake-datad0g.com/')
    )
    await page.clock.runFor(30_001)
    expect((await failedUpload).failure()).not.toBeNull()
    expect(attemptedEvents).toEqual(['sdk_initialization'])

    await page.getByLabel('Flag key').fill('boolean-flag')
    await page.getByRole('button', { name: 'Evaluate boolean details' }).click()
    await expect(page.locator('#status')).toContainText('"value": true')
    const details = JSON.parse((await page.locator('#status').textContent())!)
    expect(details).toMatchObject({ value: true, reason: 'TARGETING_MATCH', variant: 'variation-124' })
    expect(details.errorCode).toBeUndefined()
    await page.getByRole('button', { name: 'Flush diagnostics and close provider' }).click()
    await expect(page.locator('#status')).toContainText('Provider closed')
  })
}

test('slow initialization sends only its settled report', async ({ page }) => {
  const records: {
    payload: {
      runtime_id: string
      initialization: {
        outcome: string
        started_at: number
        final: boolean
        reason?: string
        duration_ms: number
      }
    }
  }[] = []
  await page.clock.install()
  await page.route('**/precompute-assignments**', (route) => route.fulfill({ json: precomputedResponse }))
  await page.route('https://browser-intake-datad0g.com/**', async (route) => {
    expect(new URL(route.request().url()).pathname).toBe('/api/v2/flagevaluation')
    expect(route.request().headers()['content-type']).toMatch(/^text\/plain(?:;|$)/)
    const lines = (route.request().postData() ?? '').split('\n').filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(32)
    for (const line of lines) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(2048)
      records.push(JSON.parse(line))
    }
    await route.fulfill({ status: 202, body: '' })
  })
  await page.goto('/diagnostics.html')
  await page.getByLabel('Staging client token').fill('test-client-token')
  await page.getByLabel('Application ID').fill('test-app')
  await page.getByLabel('Configuration request').selectOption('slow')
  await page.getByRole('button', { name: 'Initialize provider' }).click()
  await page.clock.runFor(30_001)
  expect(records).toEqual([])
  await page.clock.runFor(5_000)
  await expect(page.locator('#status')).toContainText('Initialization completed')
  await page.getByRole('button', { name: 'Flush diagnostics and close provider' }).click()
  await expect.poll(() => records.length).toBe(1)
  expect(records[0].payload.initialization).toMatchObject({ outcome: 'ready', final: true })
  expect(records[0].payload.initialization.duration_ms).toBeGreaterThanOrEqual(35_000)
  expect(records[0].payload.initialization).not.toHaveProperty('sequence')
})
