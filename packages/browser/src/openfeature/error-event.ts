import type { ErrorCode } from '@openfeature/web-sdk'
import { OpenFeatureError } from '@openfeature/web-sdk'

export type ProviderErrorEvent = {
  message: string
  errorCode?: ErrorCode
}

/** Convert an error to OpenFeature's standard event shape plus its runtime error-code extension. */
export function toProviderErrorEvent(error: unknown): ProviderErrorEvent {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof OpenFeatureError && 'code' in error) {
    return { message, errorCode: error.code as ErrorCode }
  }
  return { message }
}
