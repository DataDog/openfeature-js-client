import { addTelemetryDebug } from '@datadog/browser-core'
import type { AssignmentCache } from '@datadog/flagging-core'
import type { FlaggingConfiguration } from '../../src/domain/configuration'
import { createExposureLoggingHook } from '../../src/openfeature/exposures'
import { startExposuresBatch } from '../../src/transport/startExposuresBatch'

jest.mock('@datadog/browser-core', () => ({
  addTelemetryDebug: jest.fn(),
}))

jest.mock('../../src/transport/startExposuresBatch', () => ({
  startExposuresBatch: jest.fn(() => ({
    add: jest.fn(),
    forceFlush: jest.fn(),
    stop: jest.fn(),
  })),
}))

describe('exposure tracking cleanup', () => {
  it('continues cleanup when flushing throws', () => {
    const hook = createExposureLoggingHook({} as FlaggingConfiguration, {} as AssignmentCache)
    const batch = jest.mocked(startExposuresBatch).mock.results[0].value
    batch.forceFlush.mockImplementationOnce(() => {
      throw new Error('flush failed')
    })

    expect(() => hook.stop()).not.toThrow()
    expect(batch.stop).toHaveBeenCalledTimes(1)
    expect(addTelemetryDebug).toHaveBeenCalledWith('Error stopping exposure tracking', {
      'error.message': 'flush failed',
    })
  })
})
