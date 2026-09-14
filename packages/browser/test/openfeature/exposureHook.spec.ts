import type { AssignmentCache } from '@datadog/flagging-core'
import type { EvaluationDetails, HookContext } from '@openfeature/web-sdk'
import type { FlaggingConfiguration } from '../../src/domain/configuration'
import { createExposureLoggingHook } from '../../src/openfeature/exposures'
import { startExposuresBatch } from '../../src/transport/startExposuresBatch'

const batch = {
  add: jest.fn(),
  forceFlush: jest.fn(),
  stop: jest.fn(),
}

jest.mock('../../src/transport/startExposuresBatch', () => ({
  startExposuresBatch: jest.fn(() => batch),
}))

describe('createExposureLoggingHook', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('flushes and stops once and ignores exposures after it is stopped', () => {
    const hook = createExposureLoggingHook({} as FlaggingConfiguration, {} as AssignmentCache)

    hook.stop()
    hook.stop()
    hook.after?.({} as HookContext, {} as EvaluationDetails<boolean>)

    expect(startExposuresBatch).toHaveBeenCalledTimes(1)
    expect(batch.forceFlush).toHaveBeenCalledWith('duration_limit')
    expect(batch.stop).toHaveBeenCalledTimes(1)
    expect(batch.add).not.toHaveBeenCalled()
  })
})
