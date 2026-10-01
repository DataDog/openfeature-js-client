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
function assignmentPayload(salt?: string) {
  const flags = [
    ['new-route-planner', 'boolean', true],
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
  const requests: Record<string, unknown>[] = []
  await page.route('**/assignments?*', async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({ json: assignmentPayload(salt) })
  })
  expect(await runSmoke(page, '/obfuscation.html')).toEqual(expectedObfuscationResult)
  salt = 'f'.repeat(32)
  expect(await runSmoke(page, '/obfuscation.html')).toEqual(expectedObfuscationResult)
  expect(requests).toHaveLength(2)
  for (const request of requests) {
    expect(request).toMatchObject({
      data: {
        attributes: {
          source: { sdk_name: 'browser', sdk_version: expectedSdkVersion },
          supported_capabilities: { assignment_encodings: ['flag-key-sha256-v1'] },
        },
      },
    })
  }
  await page.waitForFunction(async (expectedSalt) => {
    return new Promise<boolean>((resolve) => {
      const request = indexedDB.open('dd-flagging')
      request.onsuccess = () => {
        const db = request.result
        const read = db.transaction('configurations').objectStore('configurations').getAll()
        read.onsuccess = () => {
          const found = read.result.some(
            (entry) => entry.precomputed?.response.data.attributes.obfuscation?.salt === expectedSalt
          )
          db.close()
          resolve(found)
        }
      }
    })
  }, salt)
  expect(await runSmoke(page, '/obfuscation.html?offline=1')).toEqual({
    ...expectedObfuscationResult,
    status: 'STALE',
  })
  expect(requests).toHaveLength(2)
})

test('keeps plaintext responses compatible when rollout is disabled', async ({ page }) => {
  await page.route('**/assignments?*', (route) => route.fulfill({ json: assignmentPayload() }))
  expect(await runSmoke(page, '/obfuscation.html')).toEqual(expectedObfuscationResult)
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
