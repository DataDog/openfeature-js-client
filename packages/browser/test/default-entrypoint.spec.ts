jest.mock('@bufbuild/protobuf', () => {
  throw new Error('The default entry point loaded Protobuf-ES')
})
jest.mock('@bufbuild/protobuf/wire', () => {
  throw new Error('The default entry point loaded Protobuf-ES wire helpers')
})

import {
  composeDatadogTrackingHooks,
  configurationFromString,
  configurationToString,
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
  DatadogProvider,
  getPrecomputedContext,
} from '../src'

describe('default entry point', () => {
  it('exports the provider without loading Protobuf-ES', () => {
    expect(DatadogProvider).toBeDefined()
    expect(composeDatadogTrackingHooks).toBeDefined()
    expect(createDatadogExposureLoggingHook).toBeDefined()
    expect(createDatadogEvaluationLoggingHook).toBeDefined()
    expect(createDatadogRumTrackingHook).toBeDefined()
  })

  it('does not export or register the core provider', () => {
    expect('DatadogCoreProvider' in jest.requireActual('../src')).toBe(false)
    expect((globalThis as { DD_FLAGGING?: { CoreProvider?: unknown } }).DD_FLAGGING?.CoreProvider).toBeUndefined()
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
        precomputed: { response: JSON.stringify(response), context: { targetingKey: 'user-1' } },
        rules: { response: 'ignored' },
      })
    )

    expect(configuration).toEqual({ precomputed: { response, context: { targetingKey: 'user-1' } } })
    expect(getPrecomputedContext(configuration)).toEqual({ targetingKey: 'user-1' })
    expect(JSON.parse(configurationToString(configuration)).rules).toBeUndefined()
  })
})
