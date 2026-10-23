import { ProviderStatus } from '@openfeature/web-sdk'
import { IDBFactory } from 'fake-indexeddb'
import { withStore } from '../../src/cache/indexeddb-store'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { ExperimentationOptOutMode } from '../../src/openfeature/experimentation-opt-out'
import { DatadogProvider } from '../../src/openfeature/provider'

const context = { targetingKey: 'selection-optout-user', dd_experimentation_opt_out_at: '2099-01-01T00:00:00Z' }
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const options: FlaggingInitConfiguration = {
  clientToken: 'selection-optout-integration',
  env: 'test',
  experimentationOptOutMode: ExperimentationOptOutMode.Immediate,
  flagSelection: { tags: ['checkout'] },
  enableExposureLogging: false,
  enableFlagEvaluationTracking: false,
  enableRumFeatureFlagTracking: false,
}
const response = (ack?: boolean) => ({
  ok: true,
  json: async () => ({
    data: {
      attributes: {
        createdAt: '2026-10-22T00:00:00Z',
        ...(ack === undefined ? {} : { evaluation_options: { experimentation_opt_out: ack } }),
        flags: {
          boolean: {
            allocationKey: 'ordinary',
            variationKey: 'on',
            variationType: 'boolean',
            variationValue: true,
            reason: 'TARGETING_MATCH',
            doLog: false,
          },
        },
      },
    },
  }),
})

describe('flag selection with experimentation opt-out', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    jest.clearAllMocks()
  })
  it('sends both policies through the public provider and checks acknowledgment', async () => {
    const fetch = jest.fn().mockResolvedValue(response(true))
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetch })
    await provider.initialize(context)
    const attributes = JSON.parse(fetch.mock.calls[0][1].body).data.attributes
    expect(attributes.flag_selection).toEqual({ tags: ['checkout'], key_patterns: [] })
    expect(attributes.evaluation_options).toEqual({ experimentation_opt_out_mode: 'immediate' })
    expect(provider.status).toBe(ProviderStatus.READY)
    expect(provider.resolveBooleanEvaluation('boolean', false, context, logger).value).toBe(true)
    await provider.onClose()

    const missing = new DatadogProvider({
      ...options,
      clientToken: 'missing-ack',
      flagConfigurationFetch: jest.fn().mockResolvedValue(response()),
    })
    await expect(missing.initialize(context)).rejects.toThrow('acknowledge')
    expect(missing.resolveBooleanEvaluation('boolean', false, context, logger).value).toBe(false)
    await missing.onClose()
  })

  it('rejects malformed opt-out before sending a selected request', async () => {
    const fetch = jest.fn().mockResolvedValue(response(true))
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetch })
    await expect(provider.initialize({ ...context, dd_experimentation_opt_out_at: 'bad' })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    await provider.onClose()
  })

  it('isolates persisted snapshots by both selection and opt-out policy', async () => {
    const provider = new DatadogProvider({
      ...options,
      flagConfigurationFetch: jest.fn().mockResolvedValue(response(true)),
    })
    await provider.initialize(context)
    const persisted = await withStore('readonly', (store) => store.getAll())
    expect(persisted).toHaveLength(1)
    await provider.onClose()
    const offline = jest.fn().mockRejectedValue(new Error('offline'))
    const wrongSelection = new DatadogProvider({
      ...options,
      flagSelection: { tags: ['search'] },
      flagConfigurationFetch: offline,
    })
    await expect(wrongSelection.initialize(context)).rejects.toThrow('offline')
    await wrongSelection.onClose()
    const wrongPolicy = new DatadogProvider({
      ...options,
      experimentationOptOutMode: ExperimentationOptOutMode.Disabled,
      flagConfigurationFetch: offline,
    })
    await expect(wrongPolicy.initialize(context)).rejects.toThrow('offline')
    await wrongPolicy.onClose()
    const same = new DatadogProvider({
      ...options,
      flagSelection: { tags: [' checkout', 'checkout'] },
      flagConfigurationFetch: offline,
    })
    await same.initialize(context)
    expect(same.status).toBe(ProviderStatus.STALE)
    expect(same.resolveBooleanEvaluation('boolean', false, context, logger).value).toBe(true)
    await same.onClose()
  })
})
