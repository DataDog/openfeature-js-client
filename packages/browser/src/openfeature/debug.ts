import { display } from '@datadog/browser-core'

type DebugDetails = Record<string, unknown>

function serialize(payload: DebugDetails): string {
  try {
    return JSON.stringify(payload)
  } catch {
    return JSON.stringify({
      product: 'feature_flags',
      event_type: 'diagnostic_serialization_failed',
    })
  }
}

function errorDetails(error: unknown): DebugDetails {
  if (error instanceof Error) {
    return { error_name: error.name, error_message: error.message }
  }
  return { error_message: String(error) }
}

export function logFeatureFlagsDebug(enabled: boolean, eventType: string, details: DebugDetails = {}): void {
  if (!enabled) {
    return
  }
  display.log(`[Feature Flags] ${serialize({ product: 'feature_flags', event_type: eventType, ...details })}`)
}

export function logFeatureFlagsDebugError(
  enabled: boolean,
  eventType: string,
  error: unknown,
  details: DebugDetails = {}
): void {
  if (!enabled) {
    return
  }
  display.error(
    `[Feature Flags] ${serialize({ product: 'feature_flags', event_type: eventType, ...details, ...errorDetails(error) })}`
  )
}
