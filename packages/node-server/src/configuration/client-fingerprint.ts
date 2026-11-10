import { SUPPORTED_FLAGS_CAPABILITIES } from '@datadog/flagging-core'

/** Decode the SDK-owned wire, then retain only response formats implemented here. Identity is not authorization. */
export function readPrecomputedCapabilities(input: unknown): readonly string[] {
  if (input === undefined) return []
  if (typeof input !== 'string') throw new Error('Invalid client fingerprint')
  const fingerprint: unknown = JSON.parse(input)
  if (!isObject(fingerprint) || fingerprint.version !== 1) throw new Error('Invalid client fingerprint version')
  const { sdk, capabilities } = fingerprint
  if (
    !isObject(sdk) ||
    typeof sdk.name !== 'string' ||
    sdk.name.length === 0 ||
    typeof sdk.version !== 'string' ||
    sdk.version.length === 0
  ) {
    throw new Error('Invalid client SDK identity')
  }
  if (!Array.isArray(capabilities) || !capabilities.every((value) => typeof value === 'string')) {
    throw new Error('Invalid capabilities')
  }
  return SUPPORTED_FLAGS_CAPABILITIES.filter((capability) => capabilities.includes(capability)).sort()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
