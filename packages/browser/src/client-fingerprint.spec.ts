import { SUPPORTED_FLAGS_CAPABILITIES } from '@datadog/flagging-core'
import { getClientFingerprint } from './client-fingerprint'

describe('getClientFingerprint', () => {
  it('encodes SDK identity and the same capabilities as browser precomputed requests', () => {
    expect(JSON.parse(getClientFingerprint())).toEqual({
      version: 1,
      sdk: { name: 'browser', version: '1.0.0-test' },
      capabilities: [...SUPPORTED_FLAGS_CAPABILITIES].sort(),
    })
  })

  it('can be forwarded as JSON', () => {
    const fingerprint = getClientFingerprint()
    expect(typeof fingerprint).toBe('string')
    expect(JSON.parse(JSON.stringify({ clientFingerprint: fingerprint })).clientFingerprint).toBe(fingerprint)
    expect(decodeURIComponent(encodeURIComponent(fingerprint))).toBe(fingerprint)
  })

  it('sorts capabilities without changing their source order', () => {
    const capabilities = ['z-test-capability', 'a-test-capability']
    jest.doMock('@datadog/flagging-core', () => ({ SUPPORTED_FLAGS_CAPABILITIES: capabilities }))
    try {
      jest.isolateModules(() => {
        const { getClientFingerprint: getIsolatedFingerprint } =
          require('./client-fingerprint') as typeof import('./client-fingerprint')
        expect(JSON.parse(getIsolatedFingerprint()).capabilities).toEqual(['a-test-capability', 'z-test-capability'])
      })
      expect(capabilities).toEqual(['z-test-capability', 'a-test-capability'])
    } finally {
      jest.dontMock('@datadog/flagging-core')
    }
  })
})
