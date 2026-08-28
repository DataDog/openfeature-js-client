import { DatadogProvider, withRetry, withTimeout } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'

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

async function run(): Promise<void> {
  let configurationAttempts = 0
  const configurationFetch: typeof fetch = async (_input, init) => {
    configurationAttempts += 1
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
  const providerDetails = OpenFeature.getClient().getBooleanDetails('packed-browser-flag', false)

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
  let timeoutErrorName: string | undefined
  try {
    await withTimeout(headersThenPendingBodyFetch, 10)('https://example.test/flags')
  } catch (error) {
    timeoutErrorName = error instanceof DOMException ? error.name : undefined
  }

  const requestBodies: string[] = []
  const replayingFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    requestBodies.push(await request.text())
    return new Response(null, { status: requestBodies.length === 1 ? 500 : 200 })
  }
  const response = await withRetry(
    replayingFetch,
    1
  )(
    new Request('https://example.test/flags', {
      method: 'POST',
      body: 'configuration request',
    })
  )

  let cancelStarted: (() => void) | undefined
  let finishCancel: (() => void) | undefined
  const cancelStartedPromise = new Promise<void>((resolve) => {
    cancelStarted = resolve
  })
  const cancelFinishedPromise = new Promise<void>((resolve) => {
    finishCancel = resolve
  })
  const retryBody = new ReadableStream({
    cancel() {
      cancelStarted?.()
      return cancelFinishedPromise
    },
  })
  const controller = new AbortController()
  let cancellationAttempts = 0
  const cancellationFetch: typeof fetch = async () => {
    cancellationAttempts += 1
    return new Response(retryBody, { status: 500 })
  }
  const cancellationRequest = withRetry(cancellationFetch, 1)('https://example.test/flags', {
    signal: controller.signal,
  })
  await cancelStartedPromise
  controller.abort(new DOMException('Configuration request superseded', 'AbortError'))
  finishCancel?.()
  let cancellationErrorName: string | undefined
  try {
    await cancellationRequest
  } catch (error) {
    cancellationErrorName = error instanceof DOMException ? error.name : undefined
  }

  assert(timeoutErrorName === 'TimeoutError', 'Timeout ended before response-body download')
  assert(configurationAttempts === 1, 'Provider used the wrong configuration request attempt count')
  assert(providerDetails.value === true, 'Packed DatadogProvider did not evaluate the canned flag')
  assert(providerDetails.reason === 'TARGETING_MATCH', 'Packed DatadogProvider returned the wrong evaluation reason')
  assert(
    providerDetails.variant === 'variation-packed-browser',
    'Packed DatadogProvider returned the wrong evaluation variant'
  )
  assert(response.status === 200, 'Request body retry did not succeed')
  assert(requestBodies.length === 2, 'Request body retry used the wrong attempt count')
  assert(
    requestBodies.every((body) => body === 'configuration request'),
    'Request body was not replayed'
  )
  assert(cancellationErrorName === 'AbortError', 'Cancellation did not reject with the caller abort reason')
  assert(cancellationAttempts === 1, 'Caller cancellation caused another attempt')

  const result = {
    providerValue: providerDetails.value,
    providerReason: providerDetails.reason,
    providerVariant: providerDetails.variant,
    configurationAttempts,
    timeoutErrorName,
    attempts: requestBodies.length,
    bodies: requestBodies,
    cancellationErrorName,
    cancellationAttempts,
  }

  Object.assign(globalThis, { __OPENFEATURE_SMOKE_RESULT__: result })
  document.querySelector<HTMLPreElement>('#app')!.textContent = JSON.stringify(result, null, 2)
}

void run().catch((error) => {
  Object.assign(globalThis, {
    __OPENFEATURE_SMOKE_ERROR__: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
