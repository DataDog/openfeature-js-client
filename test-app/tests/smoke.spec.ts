import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { expect, type Page, test } from '@playwright/test'
import type { SmokeResult as FetchSmokeResult } from '../src/smokeResult'

const { version } = createRequire(import.meta.url)('@datadog/openfeature-browser/package.json')
const expectedSdkVersion =
  process.env.BUILD_MODE === 'release'
    ? version
    : process.env.BUILD_MODE === 'canary'
      ? `${version}-${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}`
      : 'dev'

type SmokeState<T> = {
  error?: string
  result?: T
}

async function runSmoke<T>(page: Page, path: string): Promise<T> {
  const runtimeErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console.error: ${message.text()}`)
  })
  page.on('pageerror', (error) => runtimeErrors.push(`page error: ${error.message}`))

  await page.goto(path)
  await page.waitForFunction(
    () => '__OPENFEATURE_SMOKE_RESULT__' in globalThis || '__OPENFEATURE_SMOKE_ERROR__' in globalThis
  )

  const state = (await page.evaluate(() => {
    const smokeGlobal = globalThis as typeof globalThis & {
      __OPENFEATURE_SMOKE_ERROR__?: string
      __OPENFEATURE_SMOKE_RESULT__?: unknown
    }
    return {
      error: smokeGlobal.__OPENFEATURE_SMOKE_ERROR__,
      result: smokeGlobal.__OPENFEATURE_SMOKE_RESULT__,
    }
  })) as SmokeState<T>

  expect(state.error).toBeUndefined()
  expect(runtimeErrors).toEqual([])
  expect(state.result).toBeDefined()
  return state.result as T
}

test('runs the packed provider and Fetch wrapper smoke coverage', async ({ page }) => {
  const result = await runSmoke<FetchSmokeResult>(page, '/')

  expect(result).toEqual({
    provider: {
      value: true,
      reason: 'TARGETING_MATCH',
      variant: 'variation-packed-browser',
      attempts: 1,
      sdkVersion: expectedSdkVersion,
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

test('decodes and evaluates packed protobuf rules in Chromium', async ({ page }) => {
  const result = await runSmoke<Record<string, unknown>>(page, '/protobuf.html')

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

  const result = await runSmoke<Record<string, unknown>>(page, '/protobuf.html')
  expect(result.protobufTypeName).toBe('datadog.ffe.flagging.ufc.v1.FlagsConfiguration')
  expect(result.booleanValue).toBe(true)
  expect(result.integerValue).toBe(42)
  expect(result.providerValue).toBe(true)
})

test('executes the packed precomputed entrypoint in Chromium', async ({ page }) => {
  const result = await runSmoke<Record<string, unknown>>(page, '/precomputed.html')

  expect(result).toEqual({
    entrypoint: 'precomputed',
    booleanValue: true,
    rulesExcluded: true,
  })
})

// Use Node's independent SHA-256 implementation to produce the edge wire format.
function assignmentPayload(salt?: string, booleanValue = true) {
  const flags = [
    ['new-route-planner', 'boolean', booleanValue],
    ['café', 'string', 'visible-value'],
    ['number-flag', 'number', 12.5],
    ['object-flag', 'object', { nested: true }],
  ] as const
  return {
    data: {
      attributes: {
        createdAt: '2026-09-30T00:00:00Z',
        obfuscated: salt !== undefined,
        ...(salt ? { obfuscation: { scheme: 'flag-key-sha256-v1', salt } } : {}),
        flags: Object.fromEntries(
          flags.map(([key, variationType, variationValue]) => [
            salt
              ? createHash('sha256')
                  .update('datadog.feature-flags.flag-key.v1\0')
                  .update(Buffer.from(salt, 'hex'))
                  .update(key)
                  .digest('hex')
              : key,
            {
              variationType,
              variationValue,
              allocationKey: 'allocation',
              variationKey: 'on',
              reason: 'TARGETING_MATCH',
              doLog: true,
            },
          ])
        ),
      },
    },
  }
}

const expectedObfuscationResult = {
  values: [true, 'visible-value', 12.5, { nested: true }],
  flagKey: 'new-route-planner',
  variant: 'on',
  reason: 'TARGETING_MATCH',
  missing: 'FLAG_NOT_FOUND',
  mismatch: 'TYPE_MISMATCH',
  status: 'READY',
}

test('negotiates obfuscation, rotates salts, and restores hashed assignments from IndexedDB', async ({ page }) => {
  let salt = '000102030405060708090a0b0c0d0e0f'
  let booleanValue = true
  const expectStoredSalt = async () => {
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<string[]>((resolve, reject) => {
              const request = indexedDB.open('dd-flagging')
              request.onerror = () => reject(request.error)
              request.onsuccess = () => {
                const db = request.result
                if (!db.objectStoreNames.contains('configurations')) {
                  db.close()
                  resolve([])
                  return
                }
                const read = db.transaction('configurations').objectStore('configurations').getAll()
                read.onerror = () => {
                  db.close()
                  reject(read.error)
                }
                read.onsuccess = () => {
                  const salts = read.result.map(
                    (entry) => entry.precomputed?.response.data.attributes.obfuscation?.salt
                  )
                  db.close()
                  resolve(salts)
                }
              }
            })
        )
      )
      .toEqual([salt])
  }
  const requests: Record<string, unknown>[] = []
  await page.route('**/assignments?*', async (route) => {
    expect(route.request().headers()['x-dd-feature-flags-capabilities']).toBe('assignment-encoding-flag-key-256-v1')
    requests.push(route.request().postDataJSON())
    await route.fulfill({ json: assignmentPayload(salt, booleanValue) })
  })
  expect(await runSmoke(page, '/obfuscation.html')).toEqual(expectedObfuscationResult)
  await expectStoredSalt()
  salt = 'f'.repeat(32)
  booleanValue = false
  const refreshedResult = {
    ...expectedObfuscationResult,
    values: [false, ...expectedObfuscationResult.values.slice(1)],
  }
  expect(await runSmoke(page, '/obfuscation.html')).toEqual(refreshedResult)
  expect(requests).toHaveLength(2)
  for (const request of requests) {
    expect(request).not.toHaveProperty('data.attributes.supported_capabilities')
    expect(request).toMatchObject({
      data: {
        attributes: {
          source: { sdk_name: 'browser', sdk_version: expectedSdkVersion },
        },
      },
    })
  }
  await expectStoredSalt()
  expect(await runSmoke(page, '/obfuscation.html?offline=1')).toEqual({
    ...refreshedResult,
    status: 'STALE',
  })
  expect(requests).toHaveLength(2)
})

test('keeps plaintext responses compatible when rollout is disabled', async ({ page }) => {
  await page.route('**/assignments?*', (route) => route.fulfill({ json: assignmentPayload() }))
  expect(await runSmoke(page, '/obfuscation.html')).toEqual(expectedObfuscationResult)
})

test('persists exposure deduplication across reloads and isolates client tokens', async ({ page }) => {
  let salt = '000102030405060708090a0b0c0d0e0f'
  const exposures: { flag: { key: string } }[] = []
  await page.route('**/assignments?*', (route) => route.fulfill({ json: assignmentPayload(salt) }))
  await page.route(
    (url) => url.pathname === '/exposures',
    async (route) => {
      for (const line of route.request().postData()!.trim().split('\n')) exposures.push(JSON.parse(line))
      await route.fulfill({ status: 202, body: '' })
    }
  )
  const storedScopes = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const open = indexedDB.open('dd-flagging')
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const db = open.result
            const read = db.transaction('configurations').objectStore('configurations').getAllKeys()
            read.onsuccess = () => {
              db.close()
              resolve(read.result.filter((key) => String(key).startsWith('assignments-')).length)
            }
            read.onerror = () => {
              db.close()
              reject(read.error)
            }
          }
        })
    )

  expect(await runSmoke(page, '/obfuscation.html?exposures=1')).toEqual(expectedObfuscationResult)
  await expect.poll(() => exposures.length).toBe(4)
  await expect.poll(storedScopes).toBe(1)
  expect(exposures.map((event) => event.flag.key).sort()).toEqual([
    'café',
    'new-route-planner',
    'number-flag',
    'object-flag',
  ])

  salt = 'f'.repeat(32)
  expect(await runSmoke(page, '/obfuscation.html?exposures=1')).toEqual(expectedObfuscationResult)
  await page.waitForLoadState('networkidle')
  expect(exposures).toHaveLength(4)
  expect(await runSmoke(page, '/obfuscation.html?exposures=1&token=other-app')).toEqual(expectedObfuscationResult)
  await expect.poll(() => exposures.length).toBe(8)
  await expect.poll(storedScopes).toBe(2)

  expect(await runSmoke(page, '/obfuscation.html?exposures=1')).toEqual(expectedObfuscationResult)
  await page.waitForLoadState('networkidle')
  expect(exposures).toHaveLength(8)
})

test('evaluates obfuscated keys without native text encoders or Web Crypto', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(globalThis, { TextEncoder: undefined, TextDecoder: undefined })
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined })
  })
  await page.route('**/assignments?*', (route) =>
    route.fulfill({ json: assignmentPayload('000102030405060708090a0b0c0d0e0f') })
  )
  expect(await runSmoke(page, '/obfuscation.html')).toEqual(expectedObfuscationResult)
})

for (const scenario of [
  { path: '/provider.html', provider: 'datadog', rules: false },
  { path: '/core-provider.html', provider: 'datadog-core', rules: true },
]) {
  test(`runs the ${scenario.provider} bundle comparison workflow`, async ({ page }) => {
    const requests: { path: string; method: string; targetingKey?: string }[] = []
    const unexpectedRequests: string[] = []
    // Keep response fixtures and request assertions out of the measured browser bundles.
    await page.route('**/*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin === 'http://127.0.0.1:4173') {
        await route.continue()
        return
      }
      if (url.hostname === 'ufc-client.ff-cdn.datad0g.com' && scenario.rules) {
        requests.push({ path: url.pathname, method: request.method() })
        expect(request.headers().accept).toBe('application/protobuf')
        await route.fulfill({
          contentType: 'application/protobuf',
          body: Buffer.from(
            'EgRwcm9kGigKDGJyb3dzZXItZmxhZxIYEAQaAigBIhAKCmFsbG9jYXRpb24iAiADGigKDGludGVnZXItZmxhZxIYEAIaAhgqIhAKCmFsbG9jYXRpb24iAiADKgJvbg==',
            'base64'
          ),
        })
        return
      }
      if (url.hostname === 'preview.ff-cdn.datad0g.com' && !scenario.rules) {
        const targetingKey = request.postDataJSON().data.attributes.subject.targeting_key
        requests.push({ path: url.pathname, method: request.method(), targetingKey })
        await route.fulfill({
          json: {
            data: {
              attributes: {
                createdAt: '2026-09-24T00:00:00.000Z',
                flags: {
                  'browser-flag': {
                    allocationKey: 'allocation',
                    variationKey: 'on',
                    variationType: 'BOOLEAN',
                    variationValue: true,
                    reason: 'STATIC',
                    doLog: false,
                  },
                },
              },
            },
          },
        })
        return
      }
      unexpectedRequests.push(request.url())
      await route.abort()
    })

    const result = await runSmoke<Record<string, unknown>>(page, scenario.path)
    expect(result).toEqual({
      provider: scenario.provider,
      initialValue: true,
      initialReason: 'STATIC',
      updatedValue: true,
      updatedReason: 'STATIC',
      targetingKey: 'browser-user-b',
    })
    expect(unexpectedRequests).toEqual([])
    expect(requests).toEqual(
      scenario.rules
        ? [{ path: '/api/v2/feature-flagging/config/rules-based/client', method: 'GET' }]
        : [
            { path: '/precompute-assignments', method: 'POST', targetingKey: 'browser-user-a' },
            { path: '/precompute-assignments', method: 'POST', targetingKey: 'browser-user-b' },
          ]
    )
  })
}
