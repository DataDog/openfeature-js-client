import { type PrecomputedClientCompatibility, SUPPORTED_FLAGS_CAPABILITIES } from '@datadog/flagging-core'

const compatibility: PrecomputedClientCompatibility = Object.freeze({
  capabilities: Object.freeze([...SUPPORTED_FLAGS_CAPABILITIES].sort()),
})

/**
 * Describe the precomputed response formats this browser SDK can read.
 * Forward the complete object to your server. Capabilities are support, not requirements.
 */
export function getPrecomputedClientCompatibility(): PrecomputedClientCompatibility {
  return compatibility
}
