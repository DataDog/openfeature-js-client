import { withRetry } from '@datadog/openfeature-browser'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function run(): Promise<void> {
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

  assert(response.status === 200, 'Request body retry did not succeed')
  assert(requestBodies.length === 2, 'Request body retry used the wrong attempt count')
  assert(
    requestBodies.every((body) => body === 'configuration request'),
    'Request body was not replayed'
  )
  assert(cancellationResponse.status === 500, 'Cancellation changed the received response')
  assert(cancellationAttempts === 1, 'Caller cancellation caused another attempt')

  const result = {
    attempts: requestBodies.length,
    bodies: requestBodies,
    cancellationAttempts,
  }

  Object.assign(globalThis, { __OPENFEATURE_SMOKE_RESULT__: result })
  document.querySelector<HTMLPreElement>('#app')!.textContent = JSON.stringify(result, null, 2)
}

void run()
