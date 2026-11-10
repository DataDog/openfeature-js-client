import { type ClientFingerprint, SUPPORTED_FLAGS_CAPABILITIES } from '@datadog/flagging-core'

const fingerprint: ClientFingerprint = JSON.stringify({
  version: 1,
  sdk: { name: 'browser', version: __BUILD_ENV__SDK_VERSION__ },
  capabilities: [...SUPPORTED_FLAGS_CAPABILITIES].sort(),
})

/**
 * Describe this SDK and its capabilities as an opaque, versioned string.
 * Forward unchanged to your server; do not parse or construct it in application code.
 * This identifies the SDK, not a user or device, and is not authentication.
 */
export function getClientFingerprint(): ClientFingerprint {
  return fingerprint
}
