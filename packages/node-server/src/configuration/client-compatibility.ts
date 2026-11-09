import { SUPPORTED_FLAGS_CAPABILITIES } from '@datadog/flagging-core'

/** Snapshot supported capabilities without forwarding unknown formats or caller-owned arrays. */
export function readPrecomputedCapabilities(input: unknown): readonly string[] {
  if (input === undefined) return []
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Invalid compatibility')
  const capabilities = (input as { capabilities?: unknown }).capabilities
  if (!Array.isArray(capabilities)) throw new Error('Invalid capabilities')
  const snapshot = Array.from(capabilities)
  if (!snapshot.every((value) => typeof value === 'string')) throw new Error('Invalid capabilities')
  return SUPPORTED_FLAGS_CAPABILITIES.filter((capability) => snapshot.includes(capability)).sort()
}
