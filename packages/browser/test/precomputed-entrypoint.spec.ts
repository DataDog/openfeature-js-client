jest.mock('@bufbuild/protobuf', () => {
  throw new Error('The precomputed entry point loaded Protobuf-ES')
})
jest.mock('@bufbuild/protobuf/wire', () => {
  throw new Error('The precomputed entry point loaded Protobuf-ES wire helpers')
})

import {
  configurationFromString,
  configurationToString,
  DatadogOfflineProvider,
  DatadogProvider,
} from '../src/precomputed'

describe('precomputed capability entry point', () => {
  it('exports the provider without loading Protobuf-ES', () => {
    expect(DatadogOfflineProvider).toBeDefined()
    expect(DatadogProvider).toBeDefined()
  })

  it('parses and serializes precomputed configuration while ignoring rules', () => {
    const response = {
      data: {
        attributes: {
          createdAt: 0,
          flags: {},
        },
      },
    }
    const configuration = configurationFromString(
      JSON.stringify({
        version: 1,
        precomputed: { response: JSON.stringify(response) },
        rules: { response: 'ignored' },
      })
    )

    expect(configuration).toEqual({ precomputed: { response } })
    expect(JSON.parse(configurationToString(configuration)).rules).toBeUndefined()
  })
})
