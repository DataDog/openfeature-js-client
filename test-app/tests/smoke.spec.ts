import { execFileSync } from 'node:child_process'
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
