import { readPrecomputedCapabilities } from '../src/configuration/client-compatibility'

describe('readPrecomputedCapabilities', () => {
  it('returns supported capabilities once in sorted order without changing caller or SDK lists', () => {
    const supported = ['z-test-capability', 'a-test-capability']
    const input = { capabilities: ['z-test-capability', 'a-test-capability', 'z-test-capability', 'unknown'] }
    jest.doMock('@datadog/flagging-core', () => ({ SUPPORTED_FLAGS_CAPABILITIES: supported }))
    try {
      jest.isolateModules(() => {
        const { readPrecomputedCapabilities: readIsolatedCapabilities } =
          require('../src/configuration/client-compatibility') as typeof import('../src/configuration/client-compatibility')
        expect(readIsolatedCapabilities(input)).toEqual(['a-test-capability', 'z-test-capability'])
      })
      expect(supported).toEqual(['z-test-capability', 'a-test-capability'])
      expect(input.capabilities).toEqual(['z-test-capability', 'a-test-capability', 'z-test-capability', 'unknown'])
    } finally {
      jest.dontMock('@datadog/flagging-core')
    }
  })

  it('returns a detached snapshot', () => {
    const input = { capabilities: ['assignment-encoding-flag-key-256-v1'] }
    const capabilities = readPrecomputedCapabilities(input)
    input.capabilities.length = 0
    expect(capabilities).toEqual(['assignment-encoding-flag-key-256-v1'])
  })
})
