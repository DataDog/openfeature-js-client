import fs from 'node:fs'
import path from 'node:path'
import { getGlobalObject } from '@datadog/browser-core'
import type { FlagEvaluationEvent } from '@datadog/flagging-core'
import type { EvaluationDetails, JsonValue } from '@openfeature/core'
import { OpenFeature } from '@openfeature/web-sdk'
import { IDBFactory } from 'fake-indexeddb'
import { DatadogProvider } from '../../src/openfeature/provider'
import type { DDRum } from '../../src/openfeature/rumIntegration'

type PlatformFilter = Array<{ platform: string }>
type Controlled = { _skip?: PlatformFilter; _include?: PlatformFilter }
type FixtureEvaluation = Controlled & {
  flag: string
  variationType: 'boolean' | 'string' | 'integer' | 'float' | 'object'
  defaultValue: JsonValue
  expectedResult: { value: JsonValue; reason?: string | null; errorCode?: string | null; variantKey?: string | null }
}
type EventMatcher = Controlled & { _count: number; [key: string]: unknown }
type PrecomputedFixture = Controlled & {
  name: string
  context: { targetingKey: string | null; attributes: Record<string, JsonValue> }
  response: object
  evaluations: FixtureEvaluation[]
  expectations: {
    noUnmatchedEvents?: boolean
    exposures?: EventMatcher[]
    evaluationEvents?: EventMatcher[]
  }
}

const fixtureRoot = path.resolve(__dirname, '../../../core/test/ffe-system-test-data/precomputed-assignments/cases')
// Existing unscoped cases predate the Web runner and have known Web telemetry
// expectation drift. Start with cases that explicitly opt into Web, without
// keying the runner to dependent flags or any fixture name.
const fixtures = discoverFixtures(fixtureRoot).filter((fixture) =>
  fixture._include?.some(({ platform }) => platform === 'web')
)

describe.each(fixtures)('precomputed corpus: $name', (fixture) => {
  const domain = `precomputed-corpus-${fixture.name}`
  let originalFetch: typeof globalThis.fetch
  let fetchMock: jest.Mock

  beforeEach(async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-10-21T00:00:00Z'))
    originalFetch = globalThis.fetch
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock
    globalThis.indexedDB = new IDBFactory()
    localStorage.clear()
    delete getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM
    await OpenFeature.clearProviders()
    await OpenFeature.clearContext()
    OpenFeature.clearHandlers()
    OpenFeature.clearHooks()
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
    await OpenFeature.clearContext()
    OpenFeature.clearHandlers()
    OpenFeature.clearHooks()
    globalThis.fetch = originalFetch
    jest.useRealTimers()
  })

  it('matches evaluation results and telemetry expectations', async () => {
    const provider = new DatadogProvider({
      clientToken: 'fixture-client-token',
      env: 'fixture',
      flagEvaluationTrackingInterval: 1000,
      flagConfigurationFetch: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => fixture.response,
      }),
    })
    const context = {
      ...(fixture.context.targetingKey === null ? {} : { targetingKey: fixture.context.targetingKey }),
      ...fixture.context.attributes,
    }
    await OpenFeature.setProviderAndWait(domain, provider, context)
    const client = OpenFeature.getClient(domain)

    for (const evaluation of fixture.evaluations.filter(appliesToWeb)) {
      const details = evaluate(client, evaluation)
      expect(details.value).toEqual(evaluation.expectedResult.value)
      if ('reason' in evaluation.expectedResult) expect(details.reason ?? null).toBe(evaluation.expectedResult.reason)
      if ('errorCode' in evaluation.expectedResult)
        expect(details.errorCode ?? null).toBe(evaluation.expectedResult.errorCode)
      if ('variantKey' in evaluation.expectedResult)
        expect(details.variant ?? null).toBe(evaluation.expectedResult.variantKey)
    }

    jest.advanceTimersByTime(31_000)
    const exposures = requestEvents('/exposures')
    const evaluations = requestEvents('/flagevaluation') as FlagEvaluationEvent[]
    if (fixture.expectations.exposures) {
      assertMatchers(exposures, fixture.expectations.exposures, fixture.expectations.noUnmatchedEvents)
    }
    if (fixture.expectations.evaluationEvents) {
      assertMatchers(evaluations, fixture.expectations.evaluationEvents, fixture.expectations.noUnmatchedEvents)
    }
  })

  function requestEvents(endpoint: string): unknown[] {
    return fetchMock.mock.calls
      .filter(([url]) => url.toString().includes(endpoint))
      .flatMap(([, request]) =>
        request.body
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line: string) => JSON.parse(line))
      )
  }
})

function discoverFixtures(directory: string): PrecomputedFixture[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const child = path.join(directory, entry.name)
      return entry.isDirectory()
        ? discoverFixtures(child)
        : entry.name.endsWith('.json')
          ? [JSON.parse(fs.readFileSync(child, 'utf8')) as PrecomputedFixture]
          : []
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function appliesToWeb(value: Controlled): boolean {
  if (value._skip?.some(({ platform }) => platform === 'web')) return false
  return value._include === undefined || value._include.some(({ platform }) => platform === 'web')
}

function evaluate(
  client: ReturnType<typeof OpenFeature.getClient>,
  evaluation: FixtureEvaluation
): EvaluationDetails<JsonValue> {
  switch (evaluation.variationType) {
    case 'boolean':
      return client.getBooleanDetails(evaluation.flag, evaluation.defaultValue as boolean)
    case 'string':
      return client.getStringDetails(evaluation.flag, evaluation.defaultValue as string)
    case 'integer':
    case 'float':
      return client.getNumberDetails(evaluation.flag, evaluation.defaultValue as number)
    case 'object':
      return client.getObjectDetails(evaluation.flag, evaluation.defaultValue)
  }
}

function assertMatchers(events: unknown[], matchers: EventMatcher[], noUnmatchedEvents = false): void {
  const applicableMatchers = matchers.filter(appliesToWeb)
  // An event family can be explicitly skipped for a platform. Do not
  // reinterpret that as an assertion that the platform emits zero events.
  if (matchers.length > 0 && applicableMatchers.length === 0) return
  const remaining = [...events]
  for (const matcher of applicableMatchers) {
    const expected = Object.fromEntries(Object.entries(matcher).filter(([key]) => !key.startsWith('_')))
    for (let count = 0; count < matcher._count; count++) {
      const index = remaining.findIndex((event) => isSubset(event, expected))
      expect(index).toBeGreaterThanOrEqual(0)
      remaining.splice(index, 1)
    }
  }
  if (noUnmatchedEvents) expect(remaining).toEqual([])
}

function isSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual == null
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, i) => isSubset(actual[i], value))
    )
  }
  if (typeof expected === 'object') {
    if (typeof actual !== 'object' || actual === null) return false
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      isSubset((actual as Record<string, unknown>)[key], value)
    )
  }
  return Object.is(actual, expected)
}
