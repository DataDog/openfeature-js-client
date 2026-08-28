import { DatadogProvider, withRetry, withTimeout } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'
import type { SmokeResult } from './smokeResult'

const REQUEST_URL = 'https://example.test/flags'
const REQUEST_BODY = 'configuration request'

const precomputedResponse = {
  data: {
    id: 'packed-browser-smoke',
    type: 'precomputed-assignments',
    attributes: {
      createdAt: '2026-08-28T16:00:00.000Z',
      flags: {
        'packed-browser-flag': {
          allocationKey: 'allocation-packed-browser',
          variationKey: 'variation-packed-browser',
          variationType: 'BOOLEAN',
          variationValue: true,
          reason: 'TARGETING_MATCH',
          doLog: false,
          extraLogging: {},
        },
      },
    },
  },
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function getDomExceptionName(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    return error instanceof DOMException ? error.name : undefined
  }
  return undefined
}

async function runProviderSmoke() {
  let attempts = 0
  const configurationFetch: typeof fetch = async (_input, init) => {
    attempts += 1
    const headers = new Headers(init?.headers)
    assert(init?.method === 'POST', 'Provider did not issue a POST configuration request')
    assert(headers.get('dd-client-token') === 'test-token', 'Provider did not preserve the client token header')
    assert(headers.get('x-packed-browser-smoke') === 'true', 'Provider did not preserve custom headers')
    return new Response(JSON.stringify(precomputedResponse), {
      headers: { 'content-type': 'application/vnd.api+json' },
    })
  }

  const provider = new DatadogProvider({
    clientToken: 'test-token',
    env: 'test',
    customHeaders: { 'x-packed-browser-smoke': 'true' },
    enableExposureLogging: false,
    enableFlagEvaluationTracking: false,
    enableRumFeatureFlagTracking: false,
    flagConfigurationFetch: withRetry(withTimeout(configurationFetch, 1_000), 1),
  })
  await OpenFeature.setProviderAndWait(provider)
  const details = OpenFeature.getClient().getBooleanDetails('packed-browser-flag', false)

  assert(attempts === 1, 'Provider used the wrong configuration request attempt count')
  assert(details.value === true, 'Packed DatadogProvider did not evaluate the canned flag')
  assert(details.reason === 'TARGETING_MATCH', 'Packed DatadogProvider returned the wrong evaluation reason')
  assert(details.variant === 'variation-packed-browser', 'Packed DatadogProvider returned the wrong evaluation variant')

  return {
    value: details.value,
    reason: details.reason,
    variant: details.variant,
    attempts,
  }
}

async function runTimeoutSmoke() {
  const headersThenPendingBodyFetch: typeof fetch = async (_input, init) => {
    const signal = init?.signal
    return new Response(
      new ReadableStream({
        start(controller) {
          const abort = () => controller.error(signal?.reason)
          if (signal?.aborted) {
            abort()
          } else {
            signal?.addEventListener('abort', abort, { once: true })
          }
        },
      })
    )
  }

  const errorName = await getDomExceptionName(withTimeout(headersThenPendingBodyFetch, 10)(REQUEST_URL))
  assert(errorName === 'TimeoutError', 'Timeout ended before response-body download')
  return { errorName }
}

async function runRequestReplaySmoke() {
  const bodies: string[] = []
  const replayingFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    bodies.push(await request.text())
    return new Response(null, { status: bodies.length === 1 ? 500 : 200 })
  }

  const response = await withRetry(
    replayingFetch,
    1
  )(
    new Request(REQUEST_URL, {
      method: 'POST',
      body: REQUEST_BODY,
    })
  )

  assert(response.status === 200, 'Request body retry did not succeed')
  assert(bodies.length === 2, 'Request body retry used the wrong attempt count')
  assert(
    bodies.every((body) => body === REQUEST_BODY),
    'Request body was not replayed'
  )
  return { attempts: bodies.length, bodies }
}

async function runCancellationSmoke() {
  const cancellationStarted = createDeferred<void>()
  const cancellationFinished = createDeferred<void>()
  const retryBody = new ReadableStream({
    cancel() {
      cancellationStarted.resolve()
      return cancellationFinished.promise
    },
  })
  const controller = new AbortController()
  let attempts = 0
  const cancellationFetch: typeof fetch = async () => {
    attempts += 1
    return new Response(retryBody, { status: 500 })
  }

  const request = withRetry(cancellationFetch, 1)(REQUEST_URL, { signal: controller.signal })
  await cancellationStarted.promise
  controller.abort(new DOMException('Configuration request superseded', 'AbortError'))
  cancellationFinished.resolve()
  const errorName = await getDomExceptionName(request)

  assert(errorName === 'AbortError', 'Cancellation did not reject with the caller abort reason')
  assert(attempts === 1, 'Caller cancellation caused another attempt')
  return { errorName, attempts }
}

async function run(): Promise<void> {
  const result: SmokeResult = {
    provider: await runProviderSmoke(),
    timeout: await runTimeoutSmoke(),
    retry: await runRequestReplaySmoke(),
    cancellation: await runCancellationSmoke(),
  }

  Object.assign(globalThis, { __OPENFEATURE_SMOKE_RESULT__: result })
  const output = document.querySelector<HTMLPreElement>('#app')
  assert(output, 'Smoke result output element was not found')
  output.textContent = JSON.stringify(result, null, 2)
}

void run().catch((error) => {
  Object.assign(globalThis, {
    __OPENFEATURE_SMOKE_ERROR__: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
