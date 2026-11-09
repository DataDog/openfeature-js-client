import { type ClientCompatibility, SUPPORTED_FLAGS_CAPABILITIES } from '@datadog/flagging-core'

const compatibility: ClientCompatibility = Object.freeze({
  capabilities: Object.freeze([...SUPPORTED_FLAGS_CAPABILITIES].sort()),
})

/**
 * Describe compatibility information for this browser SDK.
 * Forward the complete object to your server. Capabilities are support, not requirements.
 */
export function getClientCompatibility(): ClientCompatibility {
  return compatibility
}
