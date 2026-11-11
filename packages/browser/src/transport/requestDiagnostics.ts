import { generateUUIDv7 } from './generateUUIDv7'

export type FetchTrigger = 'initialization' | 'context_change'

type RequestDiagnostics = {
  instanceId: string
  sequence: number
  trigger: FetchTrigger
}
const requests = new WeakMap<AbortSignal, RequestDiagnostics>()

/** One ephemeral identity per provider, with one sequence per accepted logical fetch. */
export function createRequestDiagnostics() {
  let instanceId: string | undefined
  try {
    instanceId = generateUUIDv7()
  } catch {
    // Diagnostics remain optional if the platform cannot provide secure randomness.
  }
  let sequence = 0
  return {
    accept(signal: AbortSignal, trigger: FetchTrigger) {
      sequence = Math.min(sequence + 1, Number.MAX_SAFE_INTEGER)
      if (instanceId) requests.set(signal, { instanceId, sequence, trigger })
    },
  }
}

export function serializeRequestBody(payload: Record<string, unknown>, signal?: AbortSignal): string {
  const request = signal ? requests.get(signal) : undefined
  let diagnostics: { sdk: { instance_id: string }; fetch: { sequence: number; trigger: FetchTrigger } } | undefined
  if (request) {
    try {
      const envelope = {
        sdk: { instance_id: request.instanceId },
        fetch: { sequence: request.sequence, trigger: request.trigger },
      }
      if (new Blob([JSON.stringify(envelope)]).size <= 4096) diagnostics = envelope
    } catch {
      // Optional diagnostics must not fail configuration fetching.
    }
  }
  return JSON.stringify(diagnostics ? { ...payload, diagnostics } : payload)
}
