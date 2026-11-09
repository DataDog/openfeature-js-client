import { SUPPORTED_FLAGS_CAPABILITIES } from '@datadog/flagging-core'
import { getClientCompatibility } from './client-compatibility'

describe('getClientCompatibility', () => {
  it('advertises the same capabilities as browser precomputed requests', () => {
    expect(getClientCompatibility()).toEqual({
      capabilities: [...SUPPORTED_FLAGS_CAPABILITIES].sort(),
    })
    expect(getClientCompatibility().capabilities).toContain('assignment-encoding-flag-key-256-v1')
  })

  it('can be forwarded as JSON', () => {
    const compatibility = getClientCompatibility()
    expect(JSON.parse(JSON.stringify(compatibility))).toEqual(compatibility)
  })

  it('does not allow callers to change subsequent results or SDK capabilities', () => {
    const compatibility = getClientCompatibility()
    expect(Object.isFrozen(compatibility)).toBe(true)
    expect(Object.isFrozen(compatibility.capabilities)).toBe(true)
    expect(() => (compatibility.capabilities as string[]).push('unsupported')).toThrow(TypeError)
    expect(() => {
      ;(compatibility as { capabilities: string[] }).capabilities = []
    }).toThrow(TypeError)
    expect(getClientCompatibility().capabilities).toEqual(SUPPORTED_FLAGS_CAPABILITIES)
  })
})
