import { withRetry, withTimeout } from '@datadog/openfeature-browser'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function run(): Promise<void> {
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
  const cancellationResponse = await cancellationRequest

  assert(timeoutErrorName === 'TimeoutError', 'Timeout ended before response-body download')
  assert(response.status === 200, 'Request body retry did not succeed')
  assert(requestBodies.length === 2, 'Request body retry used the wrong attempt count')
  assert(
    requestBodies.every((body) => body === 'configuration request'),
    'Request body was not replayed'
  )
  assert(cancellationResponse.status === 500, 'Cancellation changed the received response')
  assert(cancellationAttempts === 1, 'Caller cancellation caused another attempt')

  const result = {
    timeoutErrorName,
    attempts: requestBodies.length,
    bodies: requestBodies,
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
