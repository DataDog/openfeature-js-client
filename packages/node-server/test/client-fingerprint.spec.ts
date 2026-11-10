import { readPrecomputedCapabilities } from '../src/configuration/client-fingerprint'
import { fingerprint } from './client-fingerprint-fixture'

describe('readPrecomputedCapabilities', () => {
  it('returns supported capabilities once in sorted order without changing the SDK list', () => {
    const supported = ['z-test-capability', 'a-test-capability']
    jest.doMock('@datadog/flagging-core', () => ({ SUPPORTED_FLAGS_CAPABILITIES: supported }))
    try {
      jest.isolateModules(() => {
        const { readPrecomputedCapabilities: readIsolatedCapabilities } =
          require('../src/configuration/client-fingerprint') as typeof import('../src/configuration/client-fingerprint')
        expect(
          readIsolatedCapabilities(
            fingerprint(['z-test-capability', 'a-test-capability', 'z-test-capability', 'unknown'])
          )
        ).toEqual(['a-test-capability', 'z-test-capability'])
      })
      expect(supported).toEqual(['z-test-capability', 'a-test-capability'])
    } finally {
      jest.dontMock('@datadog/flagging-core')
    }
  })

  it('accepts other SDK identities and future fields without inferring capabilities from their version', () => {
    expect(
      readPrecomputedCapabilities(fingerprint([], { sdk: { name: 'react-native', version: '999.0.0' }, future: true }))
    ).toEqual([])
    expect(
      readPrecomputedCapabilities(
        fingerprint(['assignment-encoding-flag-key-256-v1'], { sdk: { name: 'other-sdk', version: '1.0.0' } })
      )
    ).toEqual(['assignment-encoding-flag-key-256-v1'])
  })

  it.each([
    undefined,
    null,
    [],
    {},
    { name: '', version: '1' },
    { name: 'browser', version: '' },
    { name: 1, version: '1' },
    { name: 'browser', version: 1 },
  ])('rejects malformed SDK identity %j', (sdk) => {
    expect(() => readPrecomputedCapabilities(fingerprint([], { sdk }))).toThrow()
  })
})
